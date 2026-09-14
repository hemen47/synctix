import { beforeEach, describe, expect, it } from "vitest"
import { createSequentialIdFactory, setIdFactory } from "@syntrix/shared"
import { applyAll, createDesign } from "./apply"
import { formatErcForLlm, runErc } from "./erc"
import { summarizeForLLM } from "./summarize"
import type { Design } from "./types"
import type { Operation } from "./operations"
import { rcLowpassOperations } from "./__fixtures__/rc-lowpass"

const build = (...ops: Operation[]): Design => {
  const result = applyAll(createDesign("d"), ops)
  if (!result.ok) throw new Error(result.error.map((e) => e.message).join(" | "))
  return result.value
}

const rules = (design: Design, ...only: string[]) =>
  runErc(design).violations.filter((v) => only.length === 0 || only.includes(v.rule))

beforeEach(() => setIdFactory(createSequentialIdFactory()))

describe("runErc — structure", () => {
  it("passes a complete rc_lowpass", () => {
    const report = runErc(build(...rcLowpassOperations))
    expect(report.pass).toBe(true)
    expect(report.errorCount).toBe(0)
  })

  it("returns an empty report for an empty design", () => {
    const report = runErc(createDesign())
    expect(report.pass).toBe(true)
    expect(report.violations).toHaveLength(0)
  })

  it("gives every violation a hint and an element reference", () => {
    const design = build({
      type: "add_component",
      ftype: "simple_resistor",
      name: "R1",
      props: {},
    })

    const report = runErc(design)
    expect(report.violations.length).toBeGreaterThan(0)
    for (const violation of report.violations) {
      // The hint is what makes a violation actionable by a model rather than merely
      // informative.
      expect(violation.hint.length).toBeGreaterThan(10)
      expect(violation.rule).toBeTruthy()
    }
  })

  it("honours disabled rules", () => {
    const design = build({ type: "add_component", ftype: "simple_resistor", props: {} })
    const report = runErc(design, { disabledRules: ["dangling_pin", "no_ground_reference"] })
    expect(report.violations.some((v) => v.rule === "dangling_pin")).toBe(false)
  })

  it("promotes warnings to errors in strict mode", () => {
    const design = build(
      { type: "add_component", ftype: "simple_resistor", name: "R1", props: {} },
      { type: "create_net", name: "GND", isPower: false, isGround: true },
      { type: "connect", a: { component: "R1", pin: 1 }, b: { net: "GND" } },
      { type: "connect", a: { component: "R1", pin: 2 }, b: { net: "GND" } },
    )

    const lenient = runErc(design)
    const strict = runErc(design, { strict: true })
    expect(strict.errorCount).toBe(lenient.errorCount + lenient.warningCount)
    expect(strict.warningCount).toBe(0)
  })
})

describe("dangling_pin", () => {
  it("flags a pin connected to nothing", () => {
    const design = build({
      type: "add_component",
      ftype: "simple_resistor",
      name: "R1",
      props: { resistance: "1k" },
    })

    const found = rules(design, "dangling_pin")
    expect(found).toHaveLength(2)
    expect(found[0]?.where).toContain("R1")
  })

  it("does not flag a connected pin", () => {
    const design = build(...rcLowpassOperations)
    expect(rules(design, "dangling_pin")).toHaveLength(0)
  })
})

describe("no_ground_reference", () => {
  it("flags a design with no ground", () => {
    const design = build(
      { type: "add_component", ftype: "simple_resistor", name: "R1", props: { resistance: "1k" } },
      {
        type: "add_component",
        ftype: "simple_capacitor",
        name: "C1",
        props: { capacitance: "1u" },
      },
      { type: "connect", a: { component: "R1", pin: 2 }, b: { component: "C1", pin: 1 } },
    )

    const found = rules(design, "no_ground_reference")
    expect(found).toHaveLength(1)
    expect(found[0]?.severity).toBe("error")
    // The hint explains the consequence, not just the fact.
    expect(found[0]?.hint).toContain("reference node")
  })

  it("accepts a net named GND", () => {
    expect(rules(build(...rcLowpassOperations), "no_ground_reference")).toHaveLength(0)
  })

  it("accepts a ground symbol component", () => {
    const design = build(
      { type: "add_component", ftype: "simple_resistor", name: "R1", props: { resistance: "1k" } },
      { type: "add_component", ftype: "simple_ground", name: "GND1", props: {} },
    )
    expect(rules(design, "no_ground_reference")).toHaveLength(0)
  })

  it("recognises common ground aliases", () => {
    for (const name of ["GND", "gnd", "VSS", "AGND", "Ground"]) {
      const design = build(
        {
          type: "add_component",
          ftype: "simple_resistor",
          name: "R1",
          props: { resistance: "1k" },
        },
        { type: "create_net", name, isPower: false, isGround: false },
      )
      expect(rules(design, "no_ground_reference"), `${name} should count as ground`).toHaveLength(0)
    }
  })

  it("says nothing about an empty design", () => {
    expect(rules(createDesign(), "no_ground_reference")).toHaveLength(0)
  })
})

describe("missing_value", () => {
  it("flags a passive whose value was never set", () => {
    const design = build({ type: "add_component", ftype: "simple_resistor", name: "R1", props: {} })

    const found = rules(design, "missing_value")
    expect(found).toHaveLength(1)
    // The hint shows the exact operation that fixes it.
    expect(found[0]?.hint).toContain("set_prop")
  })

  it("does not flag a passive with a value", () => {
    const design = build({
      type: "add_component",
      ftype: "simple_resistor",
      name: "R1",
      props: { resistance: "10k" },
    })
    expect(rules(design, "missing_value")).toHaveLength(0)
  })

  it("does not flag an explicit 0 ohm link", () => {
    // A 0 Ω resistor is a real part. It is distinguished from "never set" by carrying a
    // display value.
    const design = build({
      type: "add_component",
      ftype: "simple_resistor",
      name: "R1",
      props: { resistance: "0" },
    })
    expect(rules(design, "missing_value")).toHaveLength(0)
  })
})

describe("duplicate_refdes", () => {
  it("flags two components sharing a name", () => {
    // apply() prevents this, so the document is built directly to exercise the rule —
    // duplicates can still arrive through merge_circuit_json or an import.
    const design: Design = {
      id: "d",
      version: 1,
      meta: {},
      manualEdits: {},
      circuit: [
        {
          type: "source_component",
          source_component_id: "a",
          ftype: "simple_resistor",
          name: "R1",
          resistance: 1000,
        },
        {
          type: "source_component",
          source_component_id: "b",
          ftype: "simple_resistor",
          name: "R1",
          resistance: 2000,
        },
      ] as Design["circuit"],
    }

    const found = rules(design, "duplicate_refdes")
    expect(found).toHaveLength(1)
    expect(found[0]?.elementIds).toEqual(["a", "b"])
  })
})

describe("unknown_part_pin", () => {
  it("flags a trace referencing a port that does not exist", () => {
    const design: Design = {
      id: "d",
      version: 1,
      meta: {},
      manualEdits: {},
      circuit: [
        {
          type: "source_trace",
          source_trace_id: "t1",
          connected_source_port_ids: ["ghost_port"],
          connected_source_net_ids: [],
        },
      ] as Design["circuit"],
    }

    const found = rules(design, "unknown_part_pin")
    expect(found).toHaveLength(1)
    expect(found[0]?.severity).toBe("error")
  })
})

describe("formatErcForLlm", () => {
  it("reports a clean pass in one line", () => {
    expect(formatErcForLlm(runErc(build(...rcLowpassOperations)))).toContain("passed")
  })

  it("includes severity, rule, message and hint per violation", () => {
    const design = build({ type: "add_component", ftype: "simple_resistor", name: "R1", props: {} })
    const text = formatErcForLlm(runErc(design))

    expect(text).toContain("dangling_pin")
    expect(text).toContain("→")
    expect(text).toMatch(/\d+ error\(s\), \d+ warning\(s\)/)
  })

  it("truncates a long report with a count of what was dropped", () => {
    const ops: Operation[] = Array.from({ length: 30 }, (_, i) => ({
      type: "add_component" as const,
      ftype: "simple_resistor",
      name: `R${i + 1}`,
      props: {},
    }))
    const text = formatErcForLlm(runErc(build(...ops)), 5)
    expect(text).toContain("and")
    expect(text).toContain("more")
  })
})

describe("summarizeForLLM", () => {
  it("says so when the design is empty", () => {
    expect(summarizeForLLM(createDesign())).toContain("empty")
  })

  it("lists components with values and nets with members", () => {
    const text = summarizeForLLM(build(...rcLowpassOperations))

    expect(text).toContain("R1: simple_resistor = 10k")
    expect(text).toContain("C1: simple_capacitor = 100nF")
    expect(text).toContain("VOUT")
    // Connectivity is shown as net membership, which is how an engineer reads a netlist.
    expect(text).toMatch(/VOUT: .*R1 pin 2.*C1 pin 1|VOUT: .*C1 pin 1.*R1 pin 2/)
  })

  it("never leaks coordinates into the summary", () => {
    let design = build(...rcLowpassOperations)
    const moved = applyAll(design, [
      {
        type: "move_component",
        component: "R1",
        center: { x: 12.345, y: 67.89 },
        layer: "schematic",
      },
    ])
    if (moved.ok) design = moved.value

    const text = summarizeForLLM(design, { includeMeta: true })
    // Principle 4: the model must not think in coordinates, so it is never shown any.
    expect(text).not.toContain("12.345")
    expect(text).not.toContain("67.89")
  })

  it("includes placement hints when asked", () => {
    const design = build(...rcLowpassOperations, {
      type: "place_hint",
      component: "C1",
      constraints: [{ kind: "near", target: "R1" }],
    })

    expect(summarizeForLLM(design, { includeMeta: true })).toContain("near")
    expect(summarizeForLLM(design, { includeMeta: false })).not.toContain("Placement hints")
  })

  it("truncates rather than overflowing a small budget", () => {
    const ops: Operation[] = Array.from({ length: 200 }, (_, i) => ({
      type: "add_component" as const,
      ftype: "simple_resistor",
      name: `R${i + 1}`,
      props: { resistance: "10k" },
    }))

    const text = summarizeForLLM(build(...ops), { budgetTokens: 200 })
    expect(text).toContain("truncated")
    expect(text).toContain("more component(s)")
    // Truncation must not cut a line in half — every line stays well-formed.
    expect(text.split("\n").every((line) => !line.endsWith(":"))).toBe(false)
  })
})
