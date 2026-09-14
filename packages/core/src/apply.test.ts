import { beforeEach, describe, expect, it } from "vitest"
import { createSequentialIdFactory, setIdFactory } from "@syntrix/shared"
import { apply, applyAll, createDesign } from "./apply"
import { buildIndex, connectedPorts, electricalNets, resolvePort } from "./index-view"
import { validateCircuit } from "./elements"
import type { Design } from "./types"
import type { Operation } from "./operations"
import { rcLowpassBatch, rcLowpassOperations } from "./__fixtures__/rc-lowpass"

/** Apply and unwrap, failing the test with the real error rather than a bare throw. */
const run = (design: Design, ...ops: Operation[]): Design => {
  const result = applyAll(design, ops)
  if (!result.ok) {
    throw new Error(`expected success, got: ${result.error.map((e) => e.message).join(" | ")}`)
  }
  return result.value
}

const expectErrors = (design: Design, op: Operation) => {
  const result = apply(design, op)
  if (result.ok) throw new Error("expected failure, got success")
  return result.error
}

beforeEach(() => setIdFactory(createSequentialIdFactory()))

describe("apply — purity and versioning", () => {
  it("does not mutate the design it was given", () => {
    const design = createDesign("d1")
    const snapshot = JSON.stringify(design)

    run(design, { type: "add_component", ftype: "simple_resistor", props: {} })

    expect(JSON.stringify(design)).toBe(snapshot)
  })

  it("increments version once per operation", () => {
    const design = createDesign("d1")
    const after = run(design, { type: "add_component", ftype: "simple_resistor", props: {} })
    expect(after.version).toBe(1)
  })

  it("counts an atomic batch as a single version step, so undo is one step", () => {
    const design = createDesign("d1")
    const result = apply(design, rcLowpassBatch)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.version).toBe(1)
  })
})

describe("add_component", () => {
  it("creates the component and its ports", () => {
    const design = run(createDesign(), {
      type: "add_component",
      ftype: "simple_resistor",
      name: "R1",
      props: { resistance: "10k" },
    })

    const view = buildIndex(design.circuit)
    expect(view.componentsByName.has("R1")).toBe(true)
    const component = view.componentsByName.get("R1")
    expect(component).toMatchObject({ resistance: 10_000, display_resistance: "10k" })
    expect(view.portsByComponent.get(component!.source_component_id)).toHaveLength(2)
  })

  it("assigns a refdes when none is given, using schematic prefixes", () => {
    let design = run(createDesign(), {
      type: "add_component",
      ftype: "simple_resistor",
      props: {},
    })
    design = run(design, { type: "add_component", ftype: "simple_resistor", props: {} })
    design = run(design, { type: "add_component", ftype: "simple_capacitor", props: {} })

    const names = [...buildIndex(design.circuit).componentsByName.keys()]
    expect(names).toEqual(["R1", "R2", "C1"])
  })

  it("rejects a duplicate refdes with a usable hint", () => {
    const design = run(createDesign(), {
      type: "add_component",
      ftype: "simple_resistor",
      name: "R1",
      props: {},
    })

    const errors = expectErrors(design, {
      type: "add_component",
      ftype: "simple_resistor",
      name: "R1",
      props: {},
    })
    expect(errors[0]?.code).toBe("DUPLICATE_NAME")
    expect(errors[0]?.hint).toContain("automatically")
  })

  it("rejects an unknown ftype and names the alternatives", () => {
    const errors = expectErrors(createDesign(), {
      type: "add_component",
      ftype: "simple_warp_core",
      props: {},
    })
    expect(errors[0]?.code).toBe("INVALID_PROP")
    expect(errors[0]?.hint).toContain("simple_resistor")
  })

  it("rejects an unparseable value and passes the unit hint through", () => {
    const errors = expectErrors(createDesign(), {
      type: "add_component",
      ftype: "simple_resistor",
      props: { resistance: "ten thousand" },
    })
    expect(errors[0]?.code).toBe("INVALID_PROP")
    expect(errors[0]?.hint).toContain("10k")
  })

  it("reports an unresolvable partRef rather than silently falling back", () => {
    const errors = expectErrors(createDesign(), {
      type: "add_component",
      partRef: "lcsc:C12345",
      props: {},
    })
    expect(errors[0]?.code).toBe("PART_NOT_FOUND")
  })

  it("resolves a partRef through the supplied resolver", () => {
    const result = apply(
      createDesign(),
      { type: "add_component", partRef: "generic:R", name: "R9", props: {} },
      {
        resolvePart: () => ({
          ftype: "simple_resistor",
          spec: {
            pins: [
              { number: 1, name: "pin1", hints: ["pin1", "1"] },
              { number: 2, name: "pin2", hints: ["pin2", "2"] },
            ],
            pinsInterchangeable: true,
            valueProp: "resistance",
            valueUnit: "Ω",
          },
        }),
      },
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      const view = buildIndex(result.value.circuit)
      const id = view.componentsByName.get("R9")!.source_component_id
      // Provenance: the design records which catalog part produced the element.
      expect(result.value.meta[id]?.partRef).toBe("generic:R")
    }
  })
})

describe("connect and disconnect", () => {
  const twoParts = (): Design =>
    run(
      createDesign(),
      { type: "add_component", ftype: "simple_resistor", name: "R1", props: {} },
      { type: "add_component", ftype: "simple_capacitor", name: "C1", props: {} },
    )

  it("connects two pins", () => {
    const design = run(twoParts(), {
      type: "connect",
      a: { component: "R1", pin: 2 },
      b: { component: "C1", pin: 1 },
    })

    const view = buildIndex(design.circuit)
    expect(view.traces.size).toBe(1)
    const r1pin2 = resolvePort(view, { component: "R1", pin: 2 })!
    const c1pin1 = resolvePort(view, { component: "C1", pin: 1 })!
    expect(connectedPorts(view, r1pin2.source_port_id).has(c1pin1.source_port_id)).toBe(true)
  })

  it("creates a net on demand when connecting to one that does not exist", () => {
    const design = run(twoParts(), {
      type: "connect",
      a: { component: "R1", pin: 1 },
      b: { net: "VIN" },
    })

    expect(buildIndex(design.circuit).netsByName.has("VIN")).toBe(true)
  })

  it("resolves pins by port hint, not just by number", () => {
    // This is what lets an agent write connect({ component: "C1", pin: "neg" }).
    const design = run(twoParts(), {
      type: "connect",
      a: { component: "C1", pin: "neg" },
      b: { net: "GND" },
    })

    const view = buildIndex(design.circuit)
    const port = resolvePort(view, { component: "C1", pin: 2 })!
    expect(view.tracesByPort.get(port.source_port_id)).toHaveLength(1)
  })

  it("rejects an unknown pin and lists the real ones", () => {
    const errors = expectErrors(twoParts(), {
      type: "connect",
      a: { component: "R1", pin: "VCC" },
      b: { net: "GND" },
    })

    expect(errors[0]?.code).toBe("UNKNOWN_PIN")
    // The hint must be actionable in one turn: it names the pins that do exist.
    expect(errors[0]?.hint).toContain("pin1")
  })

  it("rejects an unknown component and lists what exists", () => {
    const errors = expectErrors(twoParts(), {
      type: "connect",
      a: { component: "U7", pin: 1 },
      b: { net: "GND" },
    })

    expect(errors[0]?.code).toBe("COMPONENT_NOT_FOUND")
    expect(errors[0]?.hint).toContain("R1")
  })

  it("rejects connecting a pin to itself", () => {
    const errors = expectErrors(twoParts(), {
      type: "connect",
      a: { component: "R1", pin: 1 },
      b: { component: "R1", pin: 1 },
    })
    expect(errors[0]?.code).toBe("SELF_CONNECTION")
  })

  it("disconnects a pin-to-pin trace", () => {
    let design = run(twoParts(), {
      type: "connect",
      a: { component: "R1", pin: 2 },
      b: { component: "C1", pin: 1 },
    })
    design = run(design, {
      type: "disconnect",
      a: { component: "R1", pin: 2 },
      b: { component: "C1", pin: 1 },
    })

    expect(buildIndex(design.circuit).traces.size).toBe(0)
  })

  it("reports disconnecting something that was never connected", () => {
    const errors = expectErrors(twoParts(), {
      type: "disconnect",
      a: { component: "R1", pin: 2 },
      b: { component: "C1", pin: 1 },
    })
    expect(errors[0]?.code).toBe("NOT_CONNECTED")
  })
})

describe("remove_component", () => {
  it("removes the component, its ports, and prunes its traces", () => {
    let design = run(
      createDesign(),
      { type: "add_component", ftype: "simple_resistor", name: "R1", props: {} },
      { type: "add_component", ftype: "simple_capacitor", name: "C1", props: {} },
      { type: "connect", a: { component: "R1", pin: 2 }, b: { component: "C1", pin: 1 } },
    )

    design = run(design, { type: "remove_component", component: "R1" })

    const view = buildIndex(design.circuit)
    expect(view.componentsByName.has("R1")).toBe(false)
    expect(view.ports.size).toBe(2) // only C1's remain
    // The trace connected only R1 and C1, so it now connects nothing and is dropped —
    // leaving it would dangle a reference to a deleted port.
    expect(view.traces.size).toBe(0)
  })

  it("reports an unknown component", () => {
    expect(
      expectErrors(createDesign(), { type: "remove_component", component: "R1" })[0]?.code,
    ).toBe("COMPONENT_NOT_FOUND")
  })
})

describe("rename and set_prop", () => {
  const oneResistor = () =>
    run(createDesign(), {
      type: "add_component",
      ftype: "simple_resistor",
      name: "R1",
      props: { resistance: "1k" },
    })

  it("renames a component", () => {
    const design = run(oneResistor(), { type: "rename", component: "R1", name: "R42" })
    expect(buildIndex(design.circuit).componentsByName.has("R42")).toBe(true)
  })

  it("rejects renaming onto an existing name", () => {
    const design = run(oneResistor(), {
      type: "add_component",
      ftype: "simple_resistor",
      name: "R2",
      props: {},
    })
    expect(expectErrors(design, { type: "rename", component: "R1", name: "R2" })[0]?.code).toBe(
      "DUPLICATE_NAME",
    )
  })

  it("updates both the numeric and display representations of a value", () => {
    const design = run(oneResistor(), {
      type: "set_prop",
      component: "R1",
      key: "resistance",
      value: "4k7",
    })

    const component = buildIndex(design.circuit).componentsByName.get("R1")
    // Writing only one of the two would either lose the author's intent or break every
    // consumer that computes with the number (ADR-0007).
    expect(component).toMatchObject({ resistance: 4700, display_resistance: "4k7" })
  })

  it("maps the generic key 'value' onto the ftype's own value property", () => {
    const design = run(oneResistor(), {
      type: "set_prop",
      component: "R1",
      key: "value",
      value: "2k2",
    })
    expect(buildIndex(design.circuit).componentsByName.get("R1")).toMatchObject({
      resistance: 2200,
    })
  })
})

describe("place_hint and move_component", () => {
  const oneResistor = () =>
    run(createDesign(), { type: "add_component", ftype: "simple_resistor", name: "R1", props: {} })

  it("records placement constraints in the sidecar, not in circuit-json", () => {
    const design = run(oneResistor(), {
      type: "place_hint",
      component: "R1",
      constraints: [{ kind: "near", target: "U1", maxDistanceMm: 5 }],
    })

    const id = buildIndex(design.circuit).componentsByName.get("R1")!.source_component_id
    expect(design.meta[id]?.constraints).toHaveLength(1)
    // Principle 2: nothing non-spec ever enters the element array.
    expect(validateCircuit(design.circuit).ok).toBe(true)
  })

  it("accumulates hints rather than replacing them", () => {
    let design = run(oneResistor(), {
      type: "place_hint",
      component: "R1",
      constraints: [{ kind: "align", with: "U1", axis: "x" }],
    })
    design = run(design, {
      type: "place_hint",
      component: "R1",
      constraints: [{ kind: "group", groupId: "power" }],
    })

    const id = buildIndex(design.circuit).componentsByName.get("R1")!.source_component_id
    expect(design.meta[id]?.constraints).toHaveLength(2)
  })

  it("records a user move in manualEdits, which layout must not overwrite", () => {
    const design = run(oneResistor(), {
      type: "move_component",
      component: "R1",
      center: { x: 5, y: 10 },
      layer: "schematic",
    })

    expect(design.manualEdits.schematic_placements).toEqual([
      { selector: "R1", relative_to: "group_center", center: { x: 5, y: 10 } },
    ])
  })
})

describe("batch", () => {
  it("rolls back entirely when an atomic batch fails", () => {
    const design = createDesign()
    const result = apply(design, {
      type: "batch",
      atomic: true,
      ops: [
        { type: "add_component", ftype: "simple_resistor", name: "R1", props: {} },
        { type: "connect", a: { component: "NOPE", pin: 1 }, b: { net: "GND" } },
      ],
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      // The failing operation is identified by index, so a model knows which one to fix.
      expect(result.error[0]?.message).toContain("operation 1")
    }
  })

  it("reports every failure in a non-atomic batch", () => {
    const result = apply(createDesign(), {
      type: "batch",
      atomic: false,
      ops: [
        { type: "connect", a: { component: "A", pin: 1 }, b: { net: "GND" } },
        { type: "connect", a: { component: "B", pin: 1 }, b: { net: "GND" } },
      ],
    })

    expect(result.ok).toBe(false)
    // Accumulating rather than short-circuiting lets the agent fix both in one turn.
    if (!result.ok) expect(result.error).toHaveLength(2)
  })
})

describe("merge_circuit_json — how TSX mode lands", () => {
  it("rejects elements that are not valid circuit-json", () => {
    const errors = expectErrors(createDesign(), {
      type: "merge_circuit_json",
      strategy: "append_only",
      elements: [{ type: "definitely_not_an_element", id: "x" }],
    })
    expect(errors[0]?.code).toBe("CIRCUIT_JSON_INVALID")
    expect(errors[0]?.hint).toContain("meta sidecar")
  })

  it("replaces a same-named component rather than duplicating it", () => {
    const design = run(createDesign(), {
      type: "add_component",
      ftype: "simple_resistor",
      name: "R1",
      props: { resistance: "1k" },
    })

    const merged = run(design, {
      type: "merge_circuit_json",
      strategy: "merge_by_name",
      elements: [
        {
          type: "source_component",
          source_component_id: "incoming_1",
          ftype: "simple_resistor",
          name: "R1",
          resistance: 47_000,
        },
      ],
    })

    const view = buildIndex(merged.circuit)
    expect(view.components.size).toBe(1)
    expect(view.componentsByName.get("R1")).toMatchObject({ resistance: 47_000 })
  })

  it("replace_all clears the sidecar along with the elements", () => {
    const design = run(createDesign(), {
      type: "add_component",
      ftype: "simple_resistor",
      name: "R1",
      props: {},
    })

    const merged = run(design, {
      type: "merge_circuit_json",
      strategy: "replace_all",
      elements: [],
    })

    expect(merged.circuit).toHaveLength(0)
    // Sidecar entries keyed by now-deleted ids would leak forever otherwise.
    expect(Object.keys(merged.meta)).toHaveLength(0)
  })
})

describe("rc_lowpass round-trip — M1 exit criterion", () => {
  it("builds through operations and conforms to circuit-json", () => {
    const design = run(createDesign("rc"), ...rcLowpassOperations)

    const conformance = validateCircuit(design.circuit)
    expect(conformance.ok).toBe(true)

    const view = buildIndex(design.circuit)
    expect([...view.componentsByName.keys()].sort()).toEqual(["C1", "R1"])
    expect([...view.netsByName.keys()].sort()).toEqual(["GND", "VIN", "VOUT"])
  })

  it("produces the expected electrical connectivity", () => {
    const design = run(createDesign("rc"), ...rcLowpassOperations)
    const view = buildIndex(design.circuit)

    const r1pin2 = resolvePort(view, { component: "R1", pin: 2 })!
    const c1pin1 = resolvePort(view, { component: "C1", pin: 1 })!
    const c1pin2 = resolvePort(view, { component: "C1", pin: 2 })!

    // R1.2 and C1.1 both sit on VOUT, so they are electrically one node even though no
    // trace directly joins them.
    expect(connectedPorts(view, r1pin2.source_port_id).has(c1pin1.source_port_id)).toBe(true)
    // C1.2 is on GND and must not be part of that node.
    expect(connectedPorts(view, r1pin2.source_port_id).has(c1pin2.source_port_id)).toBe(false)

    // Four pins across three nets: VIN (1), VOUT (2), GND (1).
    const nets = electricalNets(view)
    expect(nets).toHaveLength(3)
    expect(nets.map((n) => n.ports.size).sort()).toEqual([1, 1, 2])
  })

  it("survives a full serialise and reload", () => {
    const design = run(createDesign("rc"), ...rcLowpassOperations)
    const reloaded = JSON.parse(JSON.stringify(design)) as Design

    expect(validateCircuit(reloaded.circuit).ok).toBe(true)
    expect(buildIndex(reloaded.circuit).componentsByName.size).toBe(2)
  })

  it("builds identically whether applied one by one or as a batch", () => {
    setIdFactory(createSequentialIdFactory())
    const stepwise = run(createDesign("rc"), ...rcLowpassOperations)

    setIdFactory(createSequentialIdFactory())
    const batched = apply(createDesign("rc"), rcLowpassBatch)

    expect(batched.ok).toBe(true)
    if (batched.ok) {
      // Same document, whichever route it took — which is what makes the agent's batched
      // turns and the UI's single edits interchangeable.
      expect(batched.value.circuit).toEqual(stepwise.circuit)
    }
  })
})
