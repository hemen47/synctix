/**
 * Coverage for the operations not exercised by apply.test.ts, which concentrates on the
 * component/connectivity core and the rc_lowpass round-trip.
 */

import { beforeEach, describe, expect, it } from "vitest"
import { createSequentialIdFactory, setIdFactory } from "@syntrix/shared"
import { apply, applyAll, createDesign } from "./apply"
import { buildIndex, elementId, resolvePort } from "./index-view"
import { validateCircuit } from "./elements"
import { findPlacement } from "./manual-edits"
import type { Design } from "./types"
import type { Operation } from "./operations"

const build = (...ops: Operation[]): Design => {
  const result = applyAll(createDesign("d"), ops)
  if (!result.ok) throw new Error(result.error.map((e) => e.message).join(" | "))
  return result.value
}

const fail = (design: Design, op: Operation) => {
  const result = apply(design, op)
  if (result.ok) throw new Error("expected failure, got success")
  return result.error
}

beforeEach(() => setIdFactory(createSequentialIdFactory()))

describe("create_net and rename_net", () => {
  it("creates power and ground nets with their flags", () => {
    const design = build(
      { type: "create_net", name: "VCC", isPower: true, isGround: false },
      { type: "create_net", name: "GND", isPower: false, isGround: true },
    )

    const view = buildIndex(design.circuit)
    expect(view.netsByName.get("VCC")).toMatchObject({ is_power: true })
    expect(view.netsByName.get("GND")).toMatchObject({ is_ground: true })
    expect(validateCircuit(design.circuit).ok).toBe(true)
  })

  it("rejects a duplicate net name and suggests connecting instead", () => {
    const design = build({ type: "create_net", name: "VCC", isPower: true, isGround: false })
    const errors = fail(design, {
      type: "create_net",
      name: "VCC",
      isPower: false,
      isGround: false,
    })

    expect(errors[0]?.code).toBe("DUPLICATE_NAME")
    expect(errors[0]?.hint).toContain("Connect to the existing net")
  })

  it("renames a net", () => {
    const design = build(
      { type: "create_net", name: "VOUT", isPower: false, isGround: false },
      { type: "rename_net", net: "VOUT", name: "OUT" },
    )

    const view = buildIndex(design.circuit)
    expect(view.netsByName.has("OUT")).toBe(true)
    expect(view.netsByName.has("VOUT")).toBe(false)
  })

  it("rejects renaming an unknown net and lists the real ones", () => {
    const design = build({ type: "create_net", name: "VCC", isPower: false, isGround: false })
    const errors = fail(design, { type: "rename_net", net: "NOPE", name: "X" })

    expect(errors[0]?.code).toBe("NET_NOT_FOUND")
    expect(errors[0]?.hint).toContain("VCC")
  })

  it("rejects renaming a net onto an existing name", () => {
    const design = build(
      { type: "create_net", name: "A", isPower: false, isGround: false },
      { type: "create_net", name: "B", isPower: false, isGround: false },
    )
    expect(fail(design, { type: "rename_net", net: "A", name: "B" })[0]?.code).toBe(
      "DUPLICATE_NAME",
    )
  })
})

describe("add_net_label and add_power_symbol", () => {
  it("records a net label on the net's sidecar entry", () => {
    const design = build(
      { type: "create_net", name: "VOUT", isPower: false, isGround: false },
      { type: "add_net_label", net: "VOUT" },
    )

    const netId = buildIndex(design.circuit).netsByName.get("VOUT")!.source_net_id
    expect(design.meta[netId]?.notes).toContain("net label")
    // The schematic_net_label element that renders it belongs to @syntrix/layout; core
    // only records the intent, so the element array stays conformant.
    expect(validateCircuit(design.circuit).ok).toBe(true)
  })

  it("creates the net when labelling one that does not exist yet", () => {
    const design = build({ type: "add_net_label", net: "BRAND_NEW" })
    expect(buildIndex(design.circuit).netsByName.has("BRAND_NEW")).toBe(true)
  })

  it("marks a power symbol's net as a power rail", () => {
    const design = build({
      type: "add_power_symbol",
      net: "VCC",
      kind: "vcc",
      voltage: "3.3V",
    })

    const net = buildIndex(design.circuit).netsByName.get("VCC")!
    expect(net).toMatchObject({ is_power: true })
    expect(design.meta[net.source_net_id]?.notes?.[0]).toContain("3.3V")
  })

  it("marks a ground symbol's net as ground", () => {
    const design = build({ type: "add_power_symbol", net: "GND", kind: "gnd" })
    expect(buildIndex(design.circuit).netsByName.get("GND")).toMatchObject({ is_ground: true })
  })
})

describe("disconnect from a net", () => {
  const wired = () =>
    build(
      { type: "add_component", ftype: "simple_resistor", name: "R1", props: { resistance: "1k" } },
      { type: "connect", a: { component: "R1", pin: 1 }, b: { net: "VIN" } },
    )

  it("removes the trace joining a pin to a net", () => {
    const design = build(
      { type: "add_component", ftype: "simple_resistor", name: "R1", props: { resistance: "1k" } },
      { type: "connect", a: { component: "R1", pin: 1 }, b: { net: "VIN" } },
      { type: "disconnect", a: { component: "R1", pin: 1 }, b: { net: "VIN" } },
    )

    expect(buildIndex(design.circuit).traces.size).toBe(0)
    // The net element survives the disconnect — removing it would delete a net the user
    // may still be using elsewhere.
    expect(buildIndex(design.circuit).netsByName.has("VIN")).toBe(true)
  })

  it("reports disconnecting from a net that does not exist", () => {
    expect(
      fail(wired(), { type: "disconnect", a: { component: "R1", pin: 1 }, b: { net: "GHOST" } })[0]
        ?.code,
    ).toBe("NET_NOT_FOUND")
  })

  it("reports disconnecting a pin that is not on that net", () => {
    expect(
      fail(wired(), { type: "disconnect", a: { component: "R1", pin: 2 }, b: { net: "VIN" } })[0]
        ?.code,
    ).toBe("NOT_CONNECTED")
  })

  it("drops port-to-net traces when their only component is removed", () => {
    // Regression: these traces used to survive with an empty port list, because the
    // pruning rule only dropped a trace when it had no *nets* — leaving traces in the
    // document that connected nothing.
    const design = build(
      {
        type: "add_component",
        ftype: "simple_capacitor",
        name: "C1",
        props: { capacitance: "1uF" },
      },
      { type: "connect", a: { component: "C1", pin: 1 }, b: { net: "VOUT" } },
      { type: "connect", a: { component: "C1", pin: 2 }, b: { net: "GND" } },
    )
    expect(buildIndex(design.circuit).traces.size).toBe(2)

    const after = apply(design, { type: "remove_component", component: "C1" })
    expect(after.ok).toBe(true)
    if (after.ok) {
      const view = buildIndex(after.value.circuit)
      expect(view.traces.size).toBe(0)
      // The nets themselves survive — they may still be used elsewhere.
      expect(view.netsByName.size).toBe(2)
    }
  })

  it("keeps a port-to-net trace whose port belongs to a surviving component", () => {
    const design = build(
      {
        type: "add_component",
        ftype: "simple_capacitor",
        name: "C1",
        props: { capacitance: "1uF" },
      },
      { type: "add_component", ftype: "simple_resistor", name: "R1", props: { resistance: "1k" } },
      { type: "connect", a: { component: "C1", pin: 1 }, b: { net: "VOUT" } },
      { type: "connect", a: { component: "R1", pin: 1 }, b: { net: "VOUT" } },
    )

    const after = apply(design, { type: "remove_component", component: "C1" })
    expect(after.ok).toBe(true)
    if (after.ok) {
      const view = buildIndex(after.value.circuit)
      // R1's connection to VOUT must survive C1's removal.
      expect(view.traces.size).toBe(1)
      expect([...view.traces.values()][0]?.connected_source_port_ids).toHaveLength(1)
    }
  })

  it("reports an unknown component on the far side", () => {
    expect(
      fail(wired(), {
        type: "disconnect",
        a: { component: "R1", pin: 1 },
        b: { component: "NOPE", pin: 1 },
      })[0]?.code,
    ).toBe("COMPONENT_NOT_FOUND")
  })
})

describe("move_component and clear_placement", () => {
  const oneResistor = () =>
    build({ type: "add_component", ftype: "simple_resistor", name: "R1", props: {} })

  it("records the placement against the component name, not its id", () => {
    // Ids are regenerated on every TSX re-evaluation; names survive it. Keying by name
    // is what makes a user's drag outlive a recompile (ADR-0013).
    const result = apply(oneResistor(), {
      type: "move_component",
      component: "R1",
      center: { x: 1, y: 2 },
      layer: "schematic",
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(findPlacement(result.value.manualEdits, "schematic", "R1")).toMatchObject({
        selector: "R1",
        center: { x: 1, y: 2 },
        relative_to: "group_center",
      })
    }
  })

  it("replaces a previous placement rather than accumulating them", () => {
    const result = applyAll(oneResistor(), [
      { type: "move_component", component: "R1", center: { x: 1, y: 2 }, layer: "schematic" },
      { type: "move_component", component: "R1", center: { x: 9, y: 9 }, layer: "schematic" },
    ])

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.manualEdits.schematic_placements).toHaveLength(1)
      expect(findPlacement(result.value.manualEdits, "schematic", "R1")?.center).toEqual({
        x: 9,
        y: 9,
      })
    }
  })

  it("keeps schematic and pcb placements apart", () => {
    const result = applyAll(oneResistor(), [
      { type: "move_component", component: "R1", center: { x: 1, y: 2 }, layer: "schematic" },
      { type: "move_component", component: "R1", center: { x: 30, y: 40 }, layer: "pcb" },
    ])

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(findPlacement(result.value.manualEdits, "schematic", "R1")?.center).toEqual({
        x: 1,
        y: 2,
      })
      expect(findPlacement(result.value.manualEdits, "pcb", "R1")?.center).toEqual({ x: 30, y: 40 })
    }
  })

  it("keeps rotation in the sidecar, where tscircuit's placement shape has no room", () => {
    const design = oneResistor()
    const id = buildIndex(design.circuit).componentsByName.get("R1")!.source_component_id

    const result = apply(design, {
      type: "move_component",
      component: "R1",
      center: { x: 1, y: 2 },
      rotation: 90,
      layer: "schematic",
    })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.meta[id]?.rotationDeg).toBe(90)
  })

  it("clear_placement hands the component back to automatic layout", () => {
    const result = applyAll(oneResistor(), [
      { type: "move_component", component: "R1", center: { x: 1, y: 2 }, layer: "schematic" },
      { type: "clear_placement", component: "R1", layer: "schematic" },
    ])

    expect(result.ok).toBe(true)
    if (result.ok) {
      // The key is dropped entirely: an empty array would read as "pinned nothing here"
      // rather than "never touched".
      expect(result.value.manualEdits.schematic_placements).toBeUndefined()
    }
  })

  it("reports an unknown component", () => {
    expect(
      fail(oneResistor(), {
        type: "move_component",
        component: "nope",
        center: { x: 0, y: 0 },
        layer: "schematic",
      }).length,
    ).toBeGreaterThan(0)
    expect(
      fail(oneResistor(), { type: "clear_placement", component: "nope", layer: "schematic" })
        .length,
    ).toBeGreaterThan(0)
  })
})

describe("merge_circuit_json — append_only", () => {
  it("appends without touching what is already there", () => {
    const design = build({
      type: "add_component",
      ftype: "simple_resistor",
      name: "R1",
      props: { resistance: "1k" },
    })

    const merged = build(
      { type: "add_component", ftype: "simple_resistor", name: "R1", props: { resistance: "1k" } },
      {
        type: "merge_circuit_json",
        strategy: "append_only",
        elements: [
          {
            type: "source_component",
            source_component_id: "incoming_1",
            ftype: "simple_capacitor",
            name: "C9",
            capacitance: 1e-6,
          },
        ],
      },
    )

    const view = buildIndex(merged.circuit)
    expect(view.components.size).toBe(2)
    expect(view.componentsByName.get("R1")).toMatchObject({ resistance: 1000 })
    expect(design.version).toBe(1)
  })

  it("prunes traces that referenced a replaced component's ports", () => {
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
    expect(buildIndex(design.circuit).traces.size).toBe(1)

    const merged = apply(design, {
      type: "merge_circuit_json",
      strategy: "merge_by_name",
      elements: [
        {
          type: "source_component",
          source_component_id: "new_r1",
          ftype: "simple_resistor",
          name: "R1",
          resistance: 2000,
        },
      ],
    })

    expect(merged.ok).toBe(true)
    if (merged.ok) {
      // The old trace pointed at a port that no longer exists; keeping it would leave a
      // dangling reference that ERC's unknown_part_pin would then report.
      expect(buildIndex(merged.value.circuit).traces.size).toBe(0)
    }
  })
})

describe("elementId", () => {
  it("derives the id field from the element type", () => {
    const design = build({ type: "add_component", ftype: "simple_resistor", props: {} })
    const component = design.circuit.find((e) => e.type === "source_component")!
    expect(elementId(component)).toBe(
      (component as { source_component_id: string }).source_component_id,
    )
  })
})

describe("resolvePort", () => {
  it("returns undefined for a component that does not exist", () => {
    const design = build({ type: "add_component", ftype: "simple_resistor", name: "R1", props: {} })
    expect(resolvePort(buildIndex(design.circuit), { component: "ZZ", pin: 1 })).toBeUndefined()
  })

  it("resolves by component id as well as by name", () => {
    const design = build({ type: "add_component", ftype: "simple_resistor", name: "R1", props: {} })
    const view = buildIndex(design.circuit)
    const id = view.componentsByName.get("R1")!.source_component_id

    expect(resolvePort(view, { component: id, pin: 1 })).toBeDefined()
  })

  it("resolves by pin name", () => {
    const design = build({ type: "add_component", ftype: "simple_resistor", name: "R1", props: {} })
    expect(resolvePort(buildIndex(design.circuit), { component: "R1", pin: "pin2" })).toBeDefined()
  })
})
