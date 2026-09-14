/**
 * The power-related ERC rules.
 *
 * These read circuit-json's own pin semantics (`provides_power`, `requires_power`,
 * `provides_voltage`, `can_use_open_drain`). No ftype in core's built-in table sets those
 * flags — they arrive with real parts from `@syntrix/parts` at M2 — so these designs are
 * constructed directly, which is also how an imported or TSX-merged document reaches
 * ERC.
 */

import { describe, expect, it } from "vitest"
import { runErc } from "./erc"
import { validateCircuit } from "./elements"
import type { Design } from "./types"

interface PortFlags {
  provides_power?: boolean
  /** A voltage *value*, not a flag — circuit-json stores the volts supplied. */
  provides_voltage?: number
  requires_power?: boolean
  /** Likewise a value: the volts the pin needs. */
  requires_voltage?: number
  can_use_open_drain?: boolean
  must_be_connected?: boolean
  do_not_connect?: boolean
  provides_ground?: boolean
}

/** Build a two-component design whose pins carry the given flags, joined by one trace. */
const designWithPins = (a: PortFlags, b: PortFlags, extra: Partial<Design> = {}): Design => {
  const circuit = [
    {
      type: "source_component",
      source_component_id: "u1",
      ftype: "simple_chip",
      name: "U1",
    },
    {
      type: "source_component",
      source_component_id: "u2",
      ftype: "simple_chip",
      name: "U2",
    },
    {
      type: "source_port",
      source_port_id: "p1",
      source_component_id: "u1",
      name: "OUT",
      pin_number: 1,
      ...a,
    },
    {
      type: "source_port",
      source_port_id: "p2",
      source_component_id: "u2",
      name: "OUT",
      pin_number: 1,
      ...b,
    },
    {
      type: "source_trace",
      source_trace_id: "t1",
      connected_source_port_ids: ["p1", "p2"],
      connected_source_net_ids: [],
    },
  ]

  // Constructed by hand, so it is worth proving it is still valid circuit-json — a test
  // built on an invalid document would prove nothing about the real rules.
  const validated = validateCircuit(circuit)
  if (!validated.ok) {
    throw new Error(`fixture is not valid circuit-json: ${validated.error[0]?.message}`)
  }

  return { id: "d", version: 1, meta: {}, manualEdits: {}, circuit: validated.value, ...extra }
}

const find = (design: Design, rule: string) =>
  runErc(design).violations.filter((v) => v.rule === rule)

describe("output_output_short", () => {
  it("flags two driving pins on one net", () => {
    const design = designWithPins({ provides_power: true }, { provides_power: true })

    const found = find(design, "output_output_short")
    expect(found).toHaveLength(1)
    expect(found[0]?.severity).toBe("error")
    expect(found[0]?.elementIds).toEqual(["p1", "p2"])
    expect(found[0]?.hint).toContain("open-drain")
  })

  it("flags two pins driving a voltage", () => {
    const design = designWithPins({ provides_voltage: 3.3 }, { provides_voltage: 5 })
    expect(find(design, "output_output_short")).toHaveLength(1)
  })

  it("does not flag open-drain pins, because wire-OR is the point of them", () => {
    const design = designWithPins(
      { provides_power: true, can_use_open_drain: true },
      { provides_power: true, can_use_open_drain: true },
    )
    expect(find(design, "output_output_short")).toHaveLength(0)
  })

  it("does not flag a single driver with a consumer", () => {
    const design = designWithPins({ provides_power: true }, { requires_power: true })
    expect(find(design, "output_output_short")).toHaveLength(0)
  })
})

describe("power_in_without_driver", () => {
  it("flags a pin that needs power on an undriven net", () => {
    const design = designWithPins({ requires_power: true }, {})

    const found = find(design, "power_in_without_driver")
    expect(found).toHaveLength(1)
    expect(found[0]?.severity).toBe("error")
    expect(found[0]?.where).toContain("U1")
  })

  it("is satisfied by a pin that provides power", () => {
    const design = designWithPins({ requires_power: true }, { provides_power: true })
    expect(find(design, "power_in_without_driver")).toHaveLength(0)
  })

  it("is satisfied by a pin that provides a voltage", () => {
    const design = designWithPins({ requires_voltage: 3.3 }, { provides_voltage: 3.3 })
    expect(find(design, "power_in_without_driver")).toHaveLength(0)
  })

  it("is satisfied by a net flagged as a power rail, since the supply may be off-sheet", () => {
    const base = designWithPins({ requires_power: true }, {})
    const withRail: Design = {
      ...base,
      circuit: [
        ...base.circuit.filter((e) => e.type !== "source_trace"),
        {
          type: "source_net",
          source_net_id: "n1",
          name: "VCC",
          member_source_group_ids: [],
          is_power: true,
        },
        {
          type: "source_trace",
          source_trace_id: "t1",
          connected_source_port_ids: ["p1", "p2"],
          connected_source_net_ids: ["n1"],
        },
      ] as Design["circuit"],
    }

    expect(find(withRail, "power_in_without_driver")).toHaveLength(0)
  })
})

describe("dangling_pin severity", () => {
  it("is an error for a pin explicitly marked must_be_connected", () => {
    const design: Design = {
      id: "d",
      version: 1,
      meta: {},
      manualEdits: {},
      circuit: [
        { type: "source_component", source_component_id: "u1", ftype: "simple_chip", name: "U1" },
        {
          type: "source_port",
          source_port_id: "p1",
          source_component_id: "u1",
          name: "VCC",
          pin_number: 1,
          must_be_connected: true,
        },
      ] as Design["circuit"],
    }

    const found = find(design, "dangling_pin")
    expect(found).toHaveLength(1)
    expect(found[0]?.severity).toBe("error")
  })

  it("ignores a pin marked do_not_connect", () => {
    const design: Design = {
      id: "d",
      version: 1,
      meta: {},
      manualEdits: {},
      circuit: [
        { type: "source_component", source_component_id: "u1", ftype: "simple_chip", name: "U1" },
        {
          type: "source_port",
          source_port_id: "p1",
          source_component_id: "u1",
          name: "NC",
          pin_number: 1,
          do_not_connect: true,
        },
      ] as Design["circuit"],
    }

    // A no-connect pin is documented as unconnected; reporting it is noise.
    expect(find(design, "dangling_pin")).toHaveLength(0)
  })
})

describe("no_ground_reference via pin semantics", () => {
  it("accepts a design whose pin provides ground", () => {
    const design = designWithPins({ provides_ground: true }, {})
    expect(find(design, "no_ground_reference")).toHaveLength(0)
  })
})

describe("single_pin_net", () => {
  it("reports at info severity, so it never fails a build", () => {
    const design: Design = {
      id: "d",
      version: 1,
      meta: {},
      manualEdits: {},
      circuit: [
        { type: "source_component", source_component_id: "u1", ftype: "simple_chip", name: "U1" },
        {
          type: "source_port",
          source_port_id: "p1",
          source_component_id: "u1",
          name: "IO",
          pin_number: 1,
        },
        {
          type: "source_net",
          source_net_id: "n1",
          name: "SIGNAL_A",
          member_source_group_ids: [],
        },
        {
          type: "source_trace",
          source_trace_id: "t1",
          connected_source_port_ids: ["p1"],
          connected_source_net_ids: ["n1"],
        },
        // A ground reference, so the report's pass/fail reflects single_pin_net alone.
        {
          type: "source_net",
          source_net_id: "n2",
          name: "GND",
          member_source_group_ids: [],
          is_ground: true,
        },
      ] as Design["circuit"],
    }

    const found = find(design, "single_pin_net")
    expect(found).toHaveLength(1)
    expect(found[0]?.severity).toBe("info")

    const report = runErc(design)
    // Informational leads must not count towards either failure total.
    expect(report.warningCount).toBe(0)
    expect(report.pass).toBe(true)
  })

  it("is not promoted to an error by strict mode", () => {
    const design: Design = {
      id: "d",
      version: 1,
      meta: {},
      manualEdits: {},
      circuit: [
        { type: "source_component", source_component_id: "u1", ftype: "simple_chip", name: "U1" },
        {
          type: "source_port",
          source_port_id: "p1",
          source_component_id: "u1",
          name: "IO",
          pin_number: 1,
        },
        { type: "source_net", source_net_id: "n1", name: "SIGNAL_A", member_source_group_ids: [] },
        {
          type: "source_trace",
          source_trace_id: "t1",
          connected_source_port_ids: ["p1"],
          connected_source_net_ids: ["n1"],
        },
        {
          type: "source_net",
          source_net_id: "n2",
          name: "GND",
          member_source_group_ids: [],
          is_ground: true,
        },
      ] as Design["circuit"],
    }

    const strict = runErc(design, { strict: true })
    expect(strict.violations.find((v) => v.rule === "single_pin_net")?.severity).toBe("info")
  })
})
