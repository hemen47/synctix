/**
 * The canvas, without a browser.
 *
 * Everything here — which symbol a click lands on, where a wire snaps, what a drag
 * emits — is pure geometry over plain data, which is the reason `@syntrix/ui-canvas`
 * exists as a package rather than as hooks inside the React app. Playwright covers that
 * the wiring between DOM events and these functions is correct; these cover that the
 * functions themselves are.
 */

import { beforeEach, describe, expect, it } from "vitest"
import { createSequentialIdFactory, setIdFactory } from "@syntrix/shared"
import { applyAll, createDesign } from "@syntrix/core"
import type { Design, Operation } from "@syntrix/core"
import { elkLayoutStrategy } from "@syntrix/layout"
import { buildScene, symbolFor } from "./scene"
import {
  GRID_MM,
  distanceToPolyline,
  distanceToRect,
  hitOne,
  hitTest,
  orthogonalRoute,
  snapForWiring,
  snapToGrid,
  symbolsInRect,
} from "./hit-test"
import { createViewport, fitToScene, panBy, toScreen, toWorld, zoomAt } from "./viewport"
import { initialState, nextRefdes, reduce } from "./editor"
import type { PinNode, Scene } from "./types"

const OPS: Operation[] = [
  { type: "add_component", ftype: "simple_resistor", name: "R1", props: { resistance: "10k" } },
  { type: "add_component", ftype: "simple_capacitor", name: "C1", props: { capacitance: "100nF" } },
  { type: "connect", a: { component: "R1", pin: 2 }, b: { component: "C1", pin: 1 } },
]

const design = (): Design => {
  const result = applyAll(createDesign("d"), OPS)
  if (!result.ok) throw new Error(result.error.map((e) => e.message).join(" | "))
  return result.value
}

/** A laid-out design, which is what the canvas actually receives. */
const laidOutScene = async (d: Design = design()): Promise<Scene> => {
  const layout = await elkLayoutStrategy.layout(d)
  if (!layout.ok) throw new Error("layout failed")
  return buildScene([...d.circuit, ...layout.value.elements])
}

beforeEach(() => setIdFactory(createSequentialIdFactory()))

describe("buildScene", () => {
  it("draws one symbol per placed component, named by refdes", async () => {
    const scene = await laidOutScene()

    expect(scene.symbols.map((s) => s.name).sort()).toEqual(["C1", "R1"])
    // The name is what manual edits and operations key on, so it has to come through.
    expect(scene.symbols.every((s) => s.sourceComponentId.length > 0)).toBe(true)
  })

  it("gives every symbol its pins, in world coordinates", async () => {
    const scene = await laidOutScene()
    const r1 = scene.symbols.find((s) => s.name === "R1")!

    expect(r1.pins).toHaveLength(2)
    // Pins must be near their own symbol; a pin at the origin means the transform was
    // dropped somewhere, which draws a plausible-looking but unusable schematic.
    for (const pin of r1.pins) {
      expect(Math.abs(pin.at.x - r1.bounds.center.x)).toBeLessThan(10)
    }
  })

  it("marks a pin as connected when a trace reaches it", async () => {
    const scene = await laidOutScene()
    const connected = scene.symbols.flatMap((s) => s.pins).filter((p) => p.connected)

    // R1.pin2 to C1.pin1 — exactly two ends.
    expect(connected).toHaveLength(2)
  })

  it("draws a placeholder box for an ftype with no library symbol", () => {
    const scene = buildScene([
      { type: "source_component", source_component_id: "sc0", name: "U1", ftype: "simple_chip" },
      {
        type: "schematic_component",
        schematic_component_id: "sch0",
        source_component_id: "sc0",
        center: { x: 0, y: 0 },
        size: { width: 5, height: 5 },
      },
    ] as never)

    // A missing symbol should look like a placeholder, not like nothing at all.
    expect(scene.symbols[0]?.primitives).toEqual([
      { type: "box", center: { x: 0, y: 0 }, width: 5, height: 5 },
    ])
  })

  it("does not draw a component that has not been placed", () => {
    const scene = buildScene([
      {
        type: "source_component",
        source_component_id: "sc0",
        name: "R1",
        ftype: "simple_resistor",
      },
    ] as never)

    // Between an agent's edit and the next relayout a component has no position. Drawing
    // it at the origin would stack every new part on top of the last one.
    expect(scene.symbols).toHaveLength(0)
  })

  it("adds a refdes label per symbol", async () => {
    const scene = await laidOutScene()
    const refdes = scene.labels.filter((l) => l.role === "refdes").map((l) => l.text)
    expect(refdes.sort()).toEqual(["C1", "R1"])
  })
})

describe("symbolFor", () => {
  it("finds the library symbol for a known ftype", () => {
    expect(symbolFor("simple_resistor")).toBeDefined()
    expect(symbolFor("simple_capacitor")).toBeDefined()
  })

  it("picks a different entry per rotation rather than rotating artwork", () => {
    // schematic-symbols models rotation as separate entries with their text already
    // upright; rotating the artwork ourselves would rotate the text with it.
    const right = symbolFor("simple_resistor", 0)
    const down = symbolFor("simple_resistor", 90)
    expect(right).toBeDefined()
    expect(down).toBeDefined()
    expect(down).not.toBe(right)
  })

  it("returns nothing for an ftype the library does not draw", () => {
    expect(symbolFor("simple_chip")).toBeUndefined()
  })
})

describe("hit testing", () => {
  it("finds a pin before the symbol it sits on", async () => {
    const scene = await laidOutScene()
    const pin = scene.symbols[0]!.pins[0]!

    // A pin is inside its own symbol's box. If the symbol won, pins would be unclickable.
    expect(hitOne(scene, pin.at)?.kind).toBe("pin")
  })

  it("finds the symbol when the click is not near a pin", async () => {
    const scene = await laidOutScene()
    const symbol = scene.symbols[0]!

    expect(hitOne(scene, symbol.bounds.center)?.kind).toBe("symbol")
  })

  it("finds nothing in empty space", async () => {
    const scene = await laidOutScene()
    expect(hitOne(scene, { x: -500, y: -500 })).toBeUndefined()
  })

  it("can be restricted to one kind", async () => {
    const scene = await laidOutScene()
    const pin = scene.symbols[0]!.pins[0]!

    expect(
      hitTest(scene, pin.at, { kinds: ["symbol"] }).every((h) => h.node.kind === "symbol"),
    ).toBe(true)
  })

  it("prefers a pin over the symbol it sits on, even when the symbol is nearer", async () => {
    // The bug this guards: distanceToRect reports 0 anywhere inside a symbol's box, so
    // ordering by distance first let the symbol win by 0 against a pin 0.000002mm away.
    // Pins became unclickable and the wire tool could not start a wire.
    const scene = await laidOutScene()
    const symbol = scene.symbols[0]!
    const pin = symbol.pins[0]!

    const hits = hitTest(scene, pin.at, { toleranceMm: 5 })
    expect(hits[0]?.node.kind).toBe("pin")

    // Both are in range and effectively coincident, so distance cannot be the tiebreak.
    const symbolHit = hits.find((h) => h.node.kind === "symbol")
    expect(symbolHit).toBeDefined()
    expect(Math.abs(symbolHit!.distance - hits[0]!.distance)).toBeLessThan(0.001)
  })

  it("orders results of the same kind nearest first", async () => {
    const scene = await laidOutScene()
    const results = hitTest(scene, scene.symbols[0]!.bounds.center, {
      toleranceMm: 50,
      kinds: ["symbol"],
    })
    const distances = results.map((r) => r.distance)
    expect([...distances].sort((a, b) => a - b)).toEqual(distances)
  })
})

describe("distance helpers", () => {
  it("reports zero inside a rectangle", () => {
    expect(distanceToRect({ x: 0, y: 0 }, { center: { x: 0, y: 0 }, width: 4, height: 2 })).toBe(0)
  })

  it("measures perpendicular distance outside a rectangle", () => {
    expect(distanceToRect({ x: 5, y: 0 }, { center: { x: 0, y: 0 }, width: 4, height: 2 })).toBe(3)
  })

  it("measures distance to the nearest segment of a polyline", () => {
    const line = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ]
    expect(distanceToPolyline({ x: 5, y: 2 }, line)).toBe(2)
    expect(distanceToPolyline({ x: 12, y: 5 }, line)).toBe(2)
    // Past the end of a segment, the distance is to the endpoint, not to the infinite
    // line — otherwise a click far off the end of a wire would select it.
    expect(distanceToPolyline({ x: 10, y: 20 }, line)).toBe(10)
  })
})

describe("snapping", () => {
  it("snaps to the 1.27mm grid", () => {
    expect(snapToGrid({ x: 1.3, y: 2.4 })).toEqual({ x: GRID_MM, y: GRID_MM * 2 })
  })

  it("prefers a nearby pin over the grid", async () => {
    const scene = await laidOutScene()
    const pin = scene.symbols[0]!.pins[0]!

    const snapped = snapForWiring(scene, { x: pin.at.x + 0.3, y: pin.at.y + 0.3 })

    // A wire that lands one grid step from a pin looks connected and is not, which is the
    // commonest way a hand-drawn schematic is quietly wrong.
    expect(snapped.pin?.sourcePortId).toBe(pin.sourcePortId)
    expect(snapped.point).toEqual(pin.at)
  })

  it("falls back to the grid away from any pin", async () => {
    const scene = await laidOutScene()
    const snapped = snapForWiring(scene, { x: -100.4, y: -100.4 })

    expect(snapped.pin).toBeUndefined()
    // A whole number of grid steps from the origin. Checking the remainder directly would
    // be wrong for negative coordinates, where JS gives a negative remainder.
    expect(snapped.point.x / GRID_MM).toBeCloseTo(Math.round(snapped.point.x / GRID_MM), 6)
    expect(snapped.point.y / GRID_MM).toBeCloseTo(Math.round(snapped.point.y / GRID_MM), 6)
  })

  it("routes orthogonally with a single corner", () => {
    const route = orthogonalRoute({ x: 0, y: 0 }, { x: 10, y: 4 })

    expect(route).toHaveLength(3)
    for (let i = 0; i < route.length - 1; i += 1) {
      const a = route[i]!
      const b = route[i + 1]!
      expect(a.x === b.x || a.y === b.y).toBe(true)
    }
  })

  it("routes straight when the points already line up", () => {
    expect(orthogonalRoute({ x: 0, y: 0 }, { x: 10, y: 0 })).toHaveLength(2)
  })
})

describe("viewport", () => {
  it("round-trips a point through screen and world", () => {
    const viewport = createViewport(800, 600)
    const world = { x: 12.7, y: -5.08 }
    const back = toWorld(viewport, toScreen(viewport, world))

    expect(back.x).toBeCloseTo(world.x, 9)
    expect(back.y).toBeCloseTo(world.y, 9)
  })

  it("keeps the point under the cursor fixed while zooming", () => {
    const viewport = createViewport(800, 600)
    const cursor = { x: 300, y: 200 }
    const before = toWorld(viewport, cursor)
    const after = toWorld(zoomAt(viewport, cursor, 1.5), cursor)

    // Anything else and scroll-wheel zoom feels like the drawing slides away.
    expect(after.x).toBeCloseTo(before.x, 9)
    expect(after.y).toBeCloseTo(before.y, 9)
  })

  it("pans in the direction the content should move", () => {
    const viewport = createViewport(800, 600)
    // Dragging the canvas right moves the content right, so the world offset decreases.
    expect(panBy(viewport, { x: 80, y: 0 }).offset.x).toBeLessThan(viewport.offset.x)
  })

  it("fits a scene inside the viewport", async () => {
    const scene = await laidOutScene()
    const fitted = fitToScene(createViewport(800, 600), scene)

    const topLeft = toScreen(fitted, { x: scene.bounds.minX, y: scene.bounds.minY })
    const bottomRight = toScreen(fitted, { x: scene.bounds.maxX, y: scene.bounds.maxY })

    expect(topLeft.x).toBeGreaterThanOrEqual(0)
    expect(bottomRight.x).toBeLessThanOrEqual(800)
    expect(bottomRight.y).toBeLessThanOrEqual(600)
  })

  it("handles an empty scene without dividing by zero", () => {
    const empty = buildScene([])
    const fitted = fitToScene(createViewport(800, 600), empty)
    expect(Number.isFinite(fitted.scale)).toBe(true)
    expect(Number.isFinite(fitted.offset.x)).toBe(true)
  })
})

describe("editor state machine", () => {
  it("places a part as one atomic batch of add_component then move_component", async () => {
    const scene = await laidOutScene()
    const placing = reduce(
      initialState(),
      { type: "start_placing", partRef: "t0:resistor", ftype: "simple_resistor" },
      scene,
    )

    const result = reduce(placing.state, { type: "pointer_down", at: { x: 20.1, y: 10.2 } }, scene)

    // One operation, so a placement is one undo and the component is never briefly drawn
    // at the layout engine's guess before jumping to where the user clicked.
    expect(result.operations).toHaveLength(1)
    const batch = result.operations[0] as {
      type: string
      atomic: boolean
      ops: Array<{ type: string; center?: { x: number; y: number } }>
    }
    expect(batch.type).toBe("batch")
    expect(batch.atomic).toBe(true)
    expect(batch.ops.map((o) => o.type)).toEqual(["add_component", "move_component"])

    // The click position is a manual edit, so it goes through move_component rather than
    // being baked into add_component — geometry is computed, placement is chosen.
    expect(batch.ops[1]!.center).toEqual(snapToGrid({ x: 20.1, y: 10.2 }))
    expect(result.state.mode.kind).toBe("idle")
  })

  it("names a new part with the next free refdes", async () => {
    const scene = await laidOutScene()
    // R1 exists, so the next resistor is R2.
    expect(nextRefdes(scene, "simple_resistor")).toBe("R2")
    expect(nextRefdes(scene, "simple_led")).toBe("D1")
  })

  it("dragging a symbol emits one move_component", async () => {
    const scene = await laidOutScene()
    const symbol = scene.symbols.find((s) => s.name === "R1")!

    const down = reduce(initialState(), { type: "pointer_down", at: symbol.bounds.center }, scene)
    expect(down.state.mode.kind).toBe("dragging")

    const up = reduce(
      down.state,
      { type: "pointer_up", at: { x: symbol.bounds.center.x + 12.7, y: symbol.bounds.center.y } },
      scene,
    )

    expect(up.operations).toHaveLength(1)
    expect(up.operations[0]).toMatchObject({ type: "move_component", component: "R1" })
  })

  it("a drag that did not move emits nothing", async () => {
    const scene = await laidOutScene()
    const symbol = scene.symbols.find((s) => s.name === "R1")!

    const down = reduce(initialState(), { type: "pointer_down", at: symbol.bounds.center }, scene)
    const up = reduce(down.state, { type: "pointer_up", at: symbol.bounds.center }, scene)

    // A click is not an edit. Emitting a no-op move would consume an undo step.
    expect(up.operations).toEqual([])
  })

  it("wiring from one pin to another emits a connect", async () => {
    const scene = await laidOutScene()
    const from = scene.symbols.find((s) => s.name === "R1")!.pins[0]!
    const to = scene.symbols.find((s) => s.name === "C1")!.pins[1]!

    const start = reduce(initialState(), { type: "pointer_down", at: from.at }, scene)
    expect(start.state.mode.kind).toBe("wiring")

    const finish = reduce(start.state, { type: "pointer_down", at: to.at }, scene)

    expect(finish.operations).toHaveLength(1)
    expect(finish.operations[0]).toMatchObject({
      type: "connect",
      a: { component: "R1" },
      b: { component: "C1" },
    })
    expect(finish.state.mode.kind).toBe("idle")
  })

  it("clicking empty space while wiring records a corner rather than finishing", async () => {
    const scene = await laidOutScene()
    const from = scene.symbols[0]!.pins[0]!

    const start = reduce(initialState(), { type: "pointer_down", at: from.at }, scene)
    const corner = reduce(start.state, { type: "pointer_down", at: { x: -50, y: -50 } }, scene)

    expect(corner.operations).toEqual([])
    expect(corner.state.mode.kind).toBe("wiring")
    if (corner.state.mode.kind === "wiring") {
      expect(corner.state.mode.waypoints).toHaveLength(1)
    }
  })

  it("will not wire a pin to itself", async () => {
    const scene = await laidOutScene()
    const pin = scene.symbols[0]!.pins[0]!

    const start = reduce(initialState(), { type: "pointer_down", at: pin.at }, scene)
    const again = reduce(start.state, { type: "pointer_down", at: pin.at }, scene)

    expect(again.operations).toEqual([])
  })

  it("Esc abandons a half-drawn wire", async () => {
    const scene = await laidOutScene()
    const start = reduce(
      initialState(),
      { type: "pointer_down", at: scene.symbols[0]!.pins[0]!.at },
      scene,
    )
    const cancelled = reduce(start.state, { type: "key", key: "Escape" }, scene)

    // A wire that survived a cancel would silently continue on the next click.
    expect(cancelled.state.mode.kind).toBe("idle")
    expect(cancelled.operations).toEqual([])
  })

  it("Delete removes every selected component", async () => {
    const scene = await laidOutScene()
    const state = { ...initialState(), selection: scene.symbols.map((s) => s.sourceComponentId) }

    const result = reduce(state, { type: "key", key: "Delete" }, scene)

    expect(result.operations.map((o) => o.type)).toEqual(["remove_component", "remove_component"])
    expect(result.state.selection).toEqual([])
  })

  it("R rotates in place without un-pinning the symbol", async () => {
    const scene = await laidOutScene()
    const symbol = scene.symbols[0]!
    const state = { ...initialState(), selection: [symbol.sourceComponentId] }

    const result = reduce(state, { type: "key", key: "r" }, scene)

    expect(result.operations[0]).toMatchObject({
      type: "move_component",
      component: symbol.name,
      rotation: 90,
      center: symbol.bounds.center,
    })
  })

  it("W starts a wire from the selected part's first unconnected pin", async () => {
    const scene = await laidOutScene()
    const r1 = scene.symbols.find((s) => s.name === "R1")!
    const state = { ...initialState(), selection: [r1.sourceComponentId] }

    const result = reduce(state, { type: "key", key: "w" }, scene)

    expect(result.state.mode.kind).toBe("wiring")
    if (result.state.mode.kind === "wiring") {
      expect((result.state.mode.from as PinNode).connected).toBe(false)
    }
  })

  it("Ctrl+Z submits nothing — undo replays the log server-side", async () => {
    const scene = await laidOutScene()
    const result = reduce(initialState(), { type: "key", key: "z", ctrlKey: true }, scene)

    // Undo is not the inverse of an operation; it is a replay to n-1 (principle 7).
    expect(result.operations).toEqual([])
  })

  it("a rubber band selects the symbols it crosses", async () => {
    const scene = await laidOutScene()

    const down = reduce(initialState(), { type: "pointer_down", at: { x: -100, y: -100 } }, scene)
    expect(down.state.mode.kind).toBe("selecting")

    const up = reduce(down.state, { type: "pointer_up", at: { x: 1000, y: 1000 } }, scene)
    expect(up.state.selection).toHaveLength(scene.symbols.length)
  })
})

describe("symbolsInRect", () => {
  it("takes symbols whose centre is inside, not only fully enclosed ones", async () => {
    const scene = await laidOutScene()
    const symbol = scene.symbols[0]!

    const found = symbolsInRect(
      scene,
      { x: symbol.bounds.center.x - 0.1, y: symbol.bounds.center.y - 0.1 },
      { x: symbol.bounds.center.x + 0.1, y: symbol.bounds.center.y + 0.1 },
    )

    // Dragging a box across a row of parts should take the ones it crosses, which is what
    // every schematic editor does.
    expect(found.map((s) => s.name)).toContain(symbol.name)
  })
})
