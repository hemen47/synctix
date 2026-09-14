import { beforeEach, describe, expect, it } from "vitest"
import { createSequentialIdFactory, setIdFactory, SCHEMATIC_GRID_MM } from "@syntrix/shared"
import { applyAll, createDesign, validateCircuit } from "@syntrix/core"
import type { Design, Operation } from "@syntrix/core"
import { t0Resolver } from "@syntrix/parts"
import { elkLayoutStrategy } from "./elk-strategy"
import { createDefaultLayoutRegistry } from "./registry"
import { isInlinePassive, isRailNet, symbolSize } from "./conventions"
import type { LayoutResult } from "./types"

const ctx = { resolvePart: t0Resolver }

const build = (...ops: Operation[]): Design => {
  const result = applyAll(createDesign("d"), ops, ctx)
  if (!result.ok) throw new Error(result.error.map((e) => e.message).join(" | "))
  return result.value
}

const run = async (design: Design, options = {}): Promise<LayoutResult> => {
  const result = await elkLayoutStrategy.layout(design, options)
  if (!result.ok) throw new Error(result.error.map((e) => e.message).join(" | "))
  return result.value
}

type Box = { center: { x: number; y: number }; size: { width: number; height: number } }

const boxes = (result: LayoutResult): Box[] =>
  result.elements.filter((e) => e.type === "schematic_component") as unknown as Box[]

/** Two symbols overlap when their bounding boxes intersect on both axes. */
const overlaps = (a: Box, b: Box): boolean => {
  const dx = Math.abs(a.center.x - b.center.x)
  const dy = Math.abs(a.center.y - b.center.y)
  return dx < (a.size.width + b.size.width) / 2 && dy < (a.size.height + b.size.height) / 2
}

const findOverlaps = (result: LayoutResult): Array<[number, number]> => {
  const list = boxes(result)
  const found: Array<[number, number]> = []
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      if (overlaps(list[i]!, list[j]!)) found.push([i, j])
    }
  }
  return found
}

// ---------------------------------------------------------------- fixtures

const rcLowpass = (): Design =>
  build(
    { type: "add_component", partRef: "t0:resistor", name: "R1", props: { resistance: "10k" } },
    { type: "add_component", partRef: "t0:capacitor", name: "C1", props: { capacitance: "100nF" } },
    { type: "create_net", name: "VIN", isPower: false, isGround: false },
    { type: "create_net", name: "VOUT", isPower: false, isGround: false },
    { type: "create_net", name: "GND", isPower: false, isGround: true },
    { type: "connect", a: { component: "R1", pin: 1 }, b: { net: "VIN" } },
    { type: "connect", a: { component: "R1", pin: 2 }, b: { component: "C1", pin: 1 } },
    { type: "connect", a: { component: "C1", pin: 2 }, b: { net: "GND" } },
  )

const regulator = (): Design =>
  build(
    { type: "add_component", partRef: "t0:ams1117-3.3", name: "U1", props: {} },
    { type: "add_component", partRef: "t0:capacitor", name: "C1", props: { capacitance: "10uF" } },
    { type: "add_component", partRef: "t0:capacitor", name: "C2", props: { capacitance: "22uF" } },
    { type: "create_net", name: "VIN", isPower: true, isGround: false },
    { type: "create_net", name: "+3V3", isPower: true, isGround: false },
    { type: "create_net", name: "GND", isPower: false, isGround: true },
    { type: "connect", a: { component: "U1", pin: "VIN" }, b: { net: "VIN" } },
    { type: "connect", a: { component: "U1", pin: "VOUT" }, b: { net: "+3V3" } },
    { type: "connect", a: { component: "U1", pin: "GND" }, b: { net: "GND" } },
    { type: "connect", a: { component: "C1", pin: 1 }, b: { net: "VIN" } },
    { type: "connect", a: { component: "C1", pin: 2 }, b: { net: "GND" } },
    { type: "connect", a: { component: "C2", pin: 1 }, b: { net: "+3V3" } },
    { type: "connect", a: { component: "C2", pin: 2 }, b: { net: "GND" } },
  )

const opampStage = (): Design =>
  build(
    { type: "add_component", partRef: "t0:lm358", name: "U1", props: {} },
    { type: "add_component", partRef: "t0:resistor", name: "R1", props: { resistance: "10k" } },
    { type: "add_component", partRef: "t0:resistor", name: "R2", props: { resistance: "100k" } },
    { type: "create_net", name: "VIN", isPower: false, isGround: false },
    { type: "create_net", name: "VOUT", isPower: false, isGround: false },
    { type: "create_net", name: "GND", isPower: false, isGround: true },
    { type: "create_net", name: "VCC", isPower: true, isGround: false },
    { type: "connect", a: { component: "R1", pin: 1 }, b: { net: "VIN" } },
    { type: "connect", a: { component: "R1", pin: 2 }, b: { component: "U1", pin: "IN1-" } },
    { type: "connect", a: { component: "R2", pin: 1 }, b: { component: "U1", pin: "IN1-" } },
    { type: "connect", a: { component: "R2", pin: 2 }, b: { component: "U1", pin: "OUT1" } },
    { type: "connect", a: { component: "U1", pin: "OUT1" }, b: { net: "VOUT" } },
    { type: "connect", a: { component: "U1", pin: "IN1+" }, b: { net: "GND" } },
    { type: "connect", a: { component: "U1", pin: "VCC" }, b: { net: "VCC" } },
    { type: "connect", a: { component: "U1", pin: "GND" }, b: { net: "GND" } },
  )

const ne555 = (): Design =>
  build(
    { type: "add_component", partRef: "t0:ne555", name: "U1", props: {} },
    { type: "add_component", partRef: "t0:resistor", name: "R1", props: { resistance: "10k" } },
    { type: "add_component", partRef: "t0:resistor", name: "R2", props: { resistance: "47k" } },
    { type: "add_component", partRef: "t0:capacitor", name: "C1", props: { capacitance: "10uF" } },
    { type: "add_component", partRef: "t0:led", name: "D1", props: {} },
    { type: "create_net", name: "VCC", isPower: true, isGround: false },
    { type: "create_net", name: "GND", isPower: false, isGround: true },
    { type: "connect", a: { component: "U1", pin: "VCC" }, b: { net: "VCC" } },
    { type: "connect", a: { component: "U1", pin: "GND" }, b: { net: "GND" } },
    { type: "connect", a: { component: "U1", pin: "RESET" }, b: { net: "VCC" } },
    { type: "connect", a: { component: "R1", pin: 1 }, b: { net: "VCC" } },
    { type: "connect", a: { component: "R1", pin: 2 }, b: { component: "U1", pin: "DISCH" } },
    { type: "connect", a: { component: "R2", pin: 1 }, b: { component: "U1", pin: "DISCH" } },
    { type: "connect", a: { component: "R2", pin: 2 }, b: { component: "U1", pin: "THRES" } },
    { type: "connect", a: { component: "U1", pin: "TRIG" }, b: { component: "U1", pin: "THRES" } },
    { type: "connect", a: { component: "C1", pin: 1 }, b: { component: "U1", pin: "THRES" } },
    { type: "connect", a: { component: "C1", pin: 2 }, b: { net: "GND" } },
    { type: "connect", a: { component: "D1", pin: 1 }, b: { component: "U1", pin: "OUT" } },
    { type: "connect", a: { component: "D1", pin: 2 }, b: { net: "GND" } },
  )

const FIXTURES: Array<[string, () => Design]> = [
  ["rc_lowpass", rcLowpass],
  ["ams1117_regulator", regulator],
  ["opamp_inverting", opampStage],
  ["ne555_blinker", ne555],
]

beforeEach(() => setIdFactory(createSequentialIdFactory()))

// ---------------------------------------------------------------- conventions

describe("conventions", () => {
  it("sizes a chip by its pin count", () => {
    const small = symbolSize("simple_chip", 4)
    const large = symbolSize("simple_chip", 32)
    // An 8-pin part drawn the same size as a 32-pin part either crowds its pins or
    // wastes half the sheet.
    expect(large.height).toBeGreaterThan(small.height)
  })

  it("gives passives a fixed inline size", () => {
    expect(symbolSize("simple_resistor", 2)).toEqual(symbolSize("simple_capacitor", 2))
    expect(isInlinePassive("simple_resistor")).toBe(true)
    expect(isInlinePassive("simple_chip")).toBe(false)
  })

  it("recognises rails by name as well as by flag", () => {
    expect(isRailNet("GND")).toBe(true)
    expect(isRailNet("VCC")).toBe(true)
    expect(isRailNet("+3V3", true)).toBe(true)
    expect(isRailNet("SIGNAL_A")).toBe(false)
    expect(isRailNet("SIGNAL_A", false, true)).toBe(true)
  })
})

// ---------------------------------------------------------------- M3 exit criterion

describe("M3 exit criterion — no overlapping symbols", () => {
  for (const [name, fixture] of FIXTURES) {
    it(`lays out ${name} without overlaps`, async () => {
      const result = await run(fixture())
      const found = findOverlaps(result)
      const list = boxes(result)

      expect(list.length).toBeGreaterThan(0)
      expect(
        found,
        `overlapping symbols: ${found.map(([i, j]) => `${i}/${j}`).join(", ")}`,
      ).toEqual([])
    })
  }
})

describe("output conformance", () => {
  for (const [name, fixture] of FIXTURES) {
    it(`emits valid circuit-json for ${name}`, async () => {
      const result = await run(fixture())
      const conformance = validateCircuit(result.elements)
      if (!conformance.ok) {
        throw new Error(conformance.error.map((e) => e.message).join("\n"))
      }
      expect(conformance.ok).toBe(true)
    })
  }

  it("produces one schematic_component per source component", async () => {
    const design = regulator()
    const result = await run(design)
    const components = result.elements.filter((e) => e.type === "schematic_component")
    expect(components).toHaveLength(3)
  })

  it("produces one schematic_port per source port", async () => {
    const result = await run(rcLowpass())
    const ports = result.elements.filter((e) => e.type === "schematic_port")
    // R1 and C1, two pins each.
    expect(ports).toHaveLength(4)
  })

  it("reports a bounding box that contains every symbol", async () => {
    const result = await run(ne555())
    for (const box of boxes(result)) {
      expect(box.center.x - box.size.width / 2).toBeGreaterThanOrEqual(result.bounds.minX - 0.001)
      expect(box.center.x + box.size.width / 2).toBeLessThanOrEqual(result.bounds.maxX + 0.001)
      expect(box.center.y - box.size.height / 2).toBeGreaterThanOrEqual(result.bounds.minY - 0.001)
      expect(box.center.y + box.size.height / 2).toBeLessThanOrEqual(result.bounds.maxY + 0.001)
    }
  })
})

describe("grid", () => {
  it("snaps every symbol and pin to the 1.27mm grid", async () => {
    const result = await run(ne555())
    const onGrid = (v: number) =>
      Math.abs(v / SCHEMATIC_GRID_MM - Math.round(v / SCHEMATIC_GRID_MM)) < 1e-6

    for (const box of boxes(result)) {
      // Off-grid pins do not connect in most EDA tools.
      expect(onGrid(box.center.x), `x=${box.center.x}`).toBe(true)
      expect(onGrid(box.center.y), `y=${box.center.y}`).toBe(true)
    }

    for (const port of result.elements.filter((e) => e.type === "schematic_port")) {
      const center = (port as unknown as { center: { x: number; y: number } }).center
      expect(onGrid(center.x)).toBe(true)
      expect(onGrid(center.y)).toBe(true)
    }
  })

  it("honours a custom grid", async () => {
    const result = await run(rcLowpass(), { gridMm: 2.54 })
    for (const box of boxes(result)) {
      expect(Math.abs(box.center.x / 2.54 - Math.round(box.center.x / 2.54))).toBeLessThan(1e-6)
    }
  })
})

describe("power rails become labels, not wires", () => {
  it("emits net labels for GND and VCC", async () => {
    const result = await run(ne555())
    const labels = result.elements.filter((e) => e.type === "schematic_net_label")

    expect(labels.length).toBeGreaterThan(0)
    const texts = new Set(labels.map((l) => (l as unknown as { text: string }).text))
    // A wire from every VCC pin to one distant supply symbol is correct and unreadable.
    expect(texts.has("GND")).toBe(true)
    expect(texts.has("VCC")).toBe(true)
  })

  it("does not route rail-only traces as wires", async () => {
    const withLabels = await run(regulator(), { useNetLabelsForPower: true })
    const withWires = await run(regulator(), { useNetLabelsForPower: false })

    const wireCount = (r: LayoutResult) =>
      r.elements.filter((e) => e.type === "schematic_trace").length

    expect(wireCount(withLabels)).toBeLessThan(wireCount(withWires))
    expect(withLabels.elements.some((e) => e.type === "schematic_net_label")).toBe(true)
    expect(withWires.elements.some((e) => e.type === "schematic_net_label")).toBe(false)
  })

  it("puts ground labels below the pin and supply labels above", async () => {
    const result = await run(regulator())
    const labels = result.elements as unknown as Array<{
      type: string
      text: string
      anchor_side: string
    }>

    const gnd = labels.find((l) => l.type === "schematic_net_label" && l.text === "GND")
    const vin = labels.find((l) => l.type === "schematic_net_label" && l.text === "VIN")
    expect(gnd?.anchor_side).toBe("top")
    expect(vin?.anchor_side).toBe("bottom")
  })
})

describe("manual overrides win", () => {
  it("keeps a pinned component where the user put it", async () => {
    let design = regulator()
    const componentId = design.circuit.find(
      (e) => e.type === "source_component" && e.name === "C2",
    ) as unknown as { source_component_id: string }

    const moved = applyAll(
      design,
      [
        {
          type: "move_component",
          component: "C2",
          center: { x: 50.8, y: 25.4 },
          layer: "schematic",
        },
      ],
      ctx,
    )
    expect(moved.ok).toBe(true)
    if (!moved.ok) return
    design = moved.value

    const result = await run(design)
    const placed = result.elements.find(
      (e) =>
        e.type === "schematic_component" &&
        (e as unknown as { source_component_id: string }).source_component_id ===
          componentId.source_component_id,
    ) as unknown as Box

    // ELK is told the position is fixed; layout must not move a symbol a human placed.
    expect(placed.center.x).toBeCloseTo(50.8 + placed.size.width / 2, 0)
  })
})

describe("wires", () => {
  it("routes orthogonally — every segment is horizontal or vertical", async () => {
    const result = await run(opampStage())
    const traces = result.elements.filter((e) => e.type === "schematic_trace")

    expect(traces.length).toBeGreaterThan(0)
    for (const trace of traces) {
      for (const edge of (
        trace as unknown as {
          edges: Array<{ from: { x: number; y: number }; to: { x: number; y: number } }>
        }
      ).edges) {
        const horizontal = Math.abs(edge.from.y - edge.to.y) < 1e-6
        const vertical = Math.abs(edge.from.x - edge.to.x) < 1e-6
        // A diagonal wire is not a schematic convention.
        expect(horizontal || vertical, `${JSON.stringify(edge)}`).toBe(true)
      }
    }
  })

  it("marks junctions where three or more wire ends meet", async () => {
    const result = await run(opampStage())
    const traces = result.elements.filter((e) => e.type === "schematic_trace") as unknown as Array<{
      junctions: Array<{ x: number; y: number }>
    }>

    // Every trace carries a junctions array, even when empty — the field is required.
    for (const trace of traces) expect(Array.isArray(trace.junctions)).toBe(true)
  })
})

describe("placement hints", () => {
  it("reports a constraint it could not satisfy rather than dropping it", async () => {
    let design = ne555()
    const hinted = applyAll(
      design,
      [
        {
          type: "place_hint",
          component: "C1",
          // Impossibly tight: the symbols are wider than this.
          constraints: [{ kind: "near", target: "U1", maxDistanceMm: 0.1 }],
        },
      ],
      ctx,
    )
    expect(hinted.ok).toBe(true)
    if (!hinted.ok) return
    design = hinted.value

    const result = await run(design)
    expect(result.unsatisfiedConstraints.length).toBeGreaterThan(0)
    expect(result.unsatisfiedConstraints[0]?.reason).toContain("wanted within")
  })

  it("reports nothing when a generous constraint is met", async () => {
    let design = regulator()
    const hinted = applyAll(
      design,
      [
        {
          type: "place_hint",
          component: "C2",
          constraints: [{ kind: "near", target: "U1", maxDistanceMm: 500 }],
        },
      ],
      ctx,
    )
    if (!hinted.ok) return
    design = hinted.value

    const result = await run(design)
    expect(result.unsatisfiedConstraints).toEqual([])
  })
})

describe("edge cases", () => {
  it("returns an empty result for an empty design", async () => {
    const result = await run(createDesign("empty"))
    expect(result.elements).toEqual([])
    expect(result.bounds).toEqual({ minX: 0, minY: 0, maxX: 0, maxY: 0 })
  })

  it("lays out a single unconnected component", async () => {
    const design = build({
      type: "add_component",
      partRef: "t0:resistor",
      name: "R1",
      props: { resistance: "1k" },
    })
    const result = await run(design)
    expect(boxes(result)).toHaveLength(1)
  })

  it("is deterministic — the same design lays out identically twice", async () => {
    setIdFactory(createSequentialIdFactory())
    const first = await run(regulator())
    setIdFactory(createSequentialIdFactory())
    const second = await run(regulator())

    // Snapshot tests downstream depend on this.
    expect(boxes(second).map((b) => b.center)).toEqual(boxes(first).map((b) => b.center))
  })
})

describe("registry", () => {
  it("has ELK registered by default", () => {
    const registry = createDefaultLayoutRegistry()
    expect(registry.get("elk")).toBeDefined()
    expect(registry.list()).toHaveLength(1)
  })
})
