/**
 * TSX mode, end to end: compile → re-id → merge → still valid circuit-json.
 *
 * These run the real `@tscircuit/eval`, not a stub. A mocked compiler would prove nothing
 * about the one thing that matters here — that what tscircuit produces is something our
 * document can hold.
 */

import { beforeEach, describe, expect, it } from "vitest"
import { createSequentialIdFactory, setIdFactory } from "@syntrix/shared"
import { applyAll, createDesign } from "./apply"
import { validateCircuit } from "./elements"
import { buildIndex } from "./index-view"
import { mergeCompiled, mergeImpact, reidElements } from "./merge-compiled"
import { compileTsx, hasErrors, hasSkew, partitionConformant } from "./tsx"
import type { Operation } from "./operations"

const RC_TSX = `
circuit.add(
  <board width="20mm" height="20mm">
    <resistor name="R1" resistance="10k" footprint="0402" pcbX={-3} />
    <capacitor name="C1" capacitance="100nF" footprint="0402" pcbX={3} />
    <trace from=".R1 > .pin2" to=".C1 > .pin1" />
  </board>
)
`

// The render stack is slow on a cold start; these are integration tests, not unit tests.
const EVAL_TIMEOUT = 60_000

describe("compileTsx", () => {
  it(
    "evaluates a board into conformant circuit-json",
    async () => {
      const result = await compileTsx(RC_TSX)

      expect(result.ok).toBe(true)
      if (!result.ok) return

      const types = new Set(result.value.elements.map((e) => e.type))
      expect(types.has("source_component")).toBe(true)
      expect(types.has("source_trace")).toBe(true)
      // The output is parsed through circuit-json's strict union before it is returned,
      // so a compile that produced something non-conformant would already have failed.
      expect(validateCircuit(result.value.elements).ok).toBe(true)
    },
    EVAL_TIMEOUT,
  )

  it("rejects empty input without starting the render stack", async () => {
    const result = await compileTsx("   ")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error[0]?.code).toBe("TSX_COMPILE_FAILED")
  })

  it(
    "returns a syntax error as a validation error, with a hint",
    async () => {
      const result = await compileTsx("circuit.add(<board")

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error[0]?.code).toBe("TSX_COMPILE_FAILED")
        // The hint is what a model acts on, so it must never be empty.
        expect(result.error[0]?.hint.length).toBeGreaterThan(0)
      }
    },
    EVAL_TIMEOUT,
  )

  it(
    "reports a selector that matches nothing, which tscircuit does not throw on",
    async () => {
      const result = await compileTsx(`
        circuit.add(
          <board width="10mm" height="10mm">
            <resistor name="R1" resistance="1k" footprint="0402" />
            <trace from=".R1 > .pin9" to=".R1 > .pin1" />
          </board>
        )
      `)

      // This is the trap: the render *succeeds*. tscircuit records the broken trace as an
      // element rather than raising, so a caller that only checks `ok` would merge a
      // board whose wiring went nowhere.
      expect(result.ok).toBe(true)
      if (!result.ok) return

      expect(hasErrors(result.value.diagnostics)).toBe(true)
      const error = result.value.diagnostics.find((d) => d.severity === "error")
      expect(error?.type).toBe("source_trace_not_connected_error")
      expect(error?.message).toMatch(/pin9/)
    },
    EVAL_TIMEOUT,
  )

  it("gives up rather than hanging", async () => {
    const result = await compileTsx(RC_TSX, { timeoutMs: 1 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error[0]?.message).toMatch(/settle/i)
  })
})

describe("reidElements", () => {
  beforeEach(() => setIdFactory(createSequentialIdFactory()))

  it("rewrites ids and every reference to them", () => {
    const elements = [
      { type: "source_component", source_component_id: "source_component_0", name: "R1" },
      {
        type: "source_port",
        source_port_id: "source_port_0",
        source_component_id: "source_component_0",
        name: "pin1",
        pin_number: 1,
      },
      {
        type: "source_trace",
        source_trace_id: "source_trace_0",
        connected_source_port_ids: ["source_port_0"],
        connected_source_net_ids: [],
      },
    ] as never

    const reided = reidElements(elements)
    const [component, port, trace] = reided as unknown as Record<string, unknown>[]

    expect(component!["source_component_id"]).not.toBe("source_component_0")
    // The reference must follow the definition, or the document falls apart.
    expect(port!["source_component_id"]).toBe(component!["source_component_id"])
    expect(trace!["connected_source_port_ids"]).toEqual([port!["source_port_id"]])
  })

  it("leaves strings that are not ids alone", () => {
    const elements = [
      {
        type: "source_component",
        source_component_id: "source_component_0",
        name: "R1",
        ftype: "simple_resistor",
      },
    ] as never

    const [reided] = reidElements(elements) as unknown as Record<string, unknown>[]
    expect(reided!["name"]).toBe("R1")
    expect(reided!["ftype"]).toBe("simple_resistor")
  })
})

describe("mergeCompiled", () => {
  beforeEach(() => setIdFactory(createSequentialIdFactory()))

  const existing: Operation[] = [
    { type: "add_component", ftype: "simple_resistor", name: "R9", props: { resistance: "1k" } },
  ]

  const design = () => {
    const result = applyAll(createDesign("d"), existing)
    if (!result.ok) throw new Error("setup failed")
    return result.value
  }

  it(
    "lands a compiled board beside what is already there",
    async () => {
      const compiled = await compileTsx(RC_TSX)
      expect(compiled.ok).toBe(true)
      if (!compiled.ok) return

      const merged = mergeCompiled(design(), compiled.value.elements)
      expect(merged.ok).toBe(true)
      if (!merged.ok) return

      const names = [...buildIndex(merged.value.circuit).componentsByName.keys()]
      expect(names).toContain("R9")
      expect(names).toContain("R1")
      expect(names).toContain("C1")
      expect(validateCircuit(merged.value.circuit).ok).toBe(true)
    },
    EVAL_TIMEOUT,
  )

  it(
    "records provenance for what it brought in, and only that",
    async () => {
      const compiled = await compileTsx(RC_TSX)
      if (!compiled.ok) throw new Error("compile failed")

      const before = design()
      const r9 = buildIndex(before.circuit).componentsByName.get("R9")!.source_component_id

      const merged = mergeCompiled(before, compiled.value.elements, {
        provenance: { source: "agent", runId: "run_1" },
      })
      expect(merged.ok).toBe(true)
      if (!merged.ok) return

      const view = buildIndex(merged.value.circuit)
      const r1 = view.componentsByName.get("R1")!.source_component_id

      expect(merged.value.meta[r1]?.provenance).toMatchObject({ source: "agent", runId: "run_1" })
      // R9 was here before the merge and must not be claimed by it.
      expect(merged.value.meta[r9]?.provenance).toBeUndefined()
    },
    EVAL_TIMEOUT,
  )

  it(
    "does not collide with ids already in the document",
    async () => {
      const compiled = await compileTsx(RC_TSX)
      if (!compiled.ok) throw new Error("compile failed")

      const merged = mergeCompiled(design(), compiled.value.elements)
      if (!merged.ok) throw new Error("merge failed")

      const ids = merged.value.circuit.map((e) => {
        const record = e as unknown as Record<string, unknown>
        return record[`${e.type}_id`]
      })
      expect(new Set(ids).size).toBe(ids.length)
    },
    EVAL_TIMEOUT,
  )
})

describe("mergeImpact", () => {
  beforeEach(() => setIdFactory(createSequentialIdFactory()))

  it("says what a merge would overwrite before it happens", () => {
    const result = applyAll(createDesign("d"), [
      { type: "add_component", ftype: "simple_resistor", name: "R1", props: {} },
    ])
    if (!result.ok) throw new Error("setup failed")

    const incoming = [
      { type: "source_component", source_component_id: "x", name: "R1", ftype: "simple_resistor" },
      { type: "source_component", source_component_id: "y", name: "C1", ftype: "simple_capacitor" },
    ] as never

    // merge_by_name overwrites silently, so the caller has to be able to warn first.
    expect(mergeImpact(result.value, incoming)).toEqual({ replaced: ["R1"], added: ["C1"] })
  })
})

describe("partitionConformant", () => {
  it("keeps an element by stripping the one field its schema rejects", () => {
    // The live skew, reduced: @tscircuit/core emits display_offset_x as a number,
    // circuit-json declares it a string.
    const result = partitionConformant([
      {
        type: "pcb_component",
        pcb_component_id: "pcb_component_0",
        source_component_id: "source_component_0",
        center: { x: 0, y: 0 },
        width: 1,
        height: 1,
        layer: "top",
        rotation: 0,
        display_offset_x: -3,
      },
    ])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.elements).toHaveLength(1)
    expect(result.value.skew.strippedFields).toEqual([
      { type: "pcb_component", field: "display_offset_x", count: 1 },
    ])
    // Stripped, not coerced: an unparseable value never becomes a plausible one.
    expect(result.value.elements[0]).not.toHaveProperty("display_offset_x")
  })

  it("drops an element type the union does not know", () => {
    const result = partitionConformant([{ type: "pcb_glitter", amount: "lots" }])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.elements).toHaveLength(0)
    expect(result.value.skew.droppedElements).toEqual([{ type: "pcb_glitter", count: 1 }])
  })

  it("still fails on a known element that stripping cannot rescue", () => {
    // source_component_id is required; removing it does not make this valid, so this is
    // a real error rather than a spelling skew.
    const result = partitionConformant([
      { type: "pcb_component", pcb_component_id: "p0", center: { x: 0, y: 0 } },
    ])

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error[0]?.code).toBe("CIRCUIT_JSON_INVALID")
  })

  it("reports no skew for a document the spec fully accepts", () => {
    const built = applyAll(createDesign("d"), [
      { type: "add_component", ftype: "simple_resistor", name: "R1", props: { resistance: "1k" } },
    ])
    if (!built.ok) throw new Error("setup failed")

    const result = partitionConformant(built.value.circuit)

    expect(result.ok).toBe(true)
    if (result.ok) expect(hasSkew(result.value.skew)).toBe(false)
  })
})
