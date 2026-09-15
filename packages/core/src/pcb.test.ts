/**
 * The PCB layer.
 *
 * M9's criterion is a routed board with real `pcb_trace` elements, so these tests route a
 * real one through tscircuit rather than asserting on a fixture. That makes them slow —
 * the router is doing actual work — and it makes them mean something: a fixture would
 * still pass if the routing path broke entirely.
 */

import { beforeEach, describe, expect, it } from "vitest"
import { createSequentialIdFactory, setIdFactory } from "@syntrix/shared"
import { applyAll, createDesign } from "./apply"
import { validateCircuit } from "./elements"
import { routePcb, routingFailed, withRoutedPcb } from "./pcb"
import type { Operation } from "./operations"
import type { Design } from "./types"

const ROUTE_TIMEOUT = 120_000

/**
 * Two placed 0402 parts and a trace between them.
 *
 * Footprints matter here in a way they do not on a schematic: a component with no
 * footprint has no pads, and a board with no pads is not a board.
 */
const TWO_PART_BOARD: Operation[] = [
  {
    type: "add_component",
    ftype: "simple_resistor",
    name: "R1",
    props: { resistance: "10k", footprint: "0402" },
  },
  {
    type: "add_component",
    ftype: "simple_capacitor",
    name: "C1",
    props: { capacitance: "100nF", footprint: "0402" },
  },
  { type: "connect", a: { component: "R1", pin: 2 }, b: { component: "C1", pin: 1 } },
  // Placement is a manual edit on the pcb layer — the same operation the PCB tab emits.
  { type: "move_component", component: "R1", center: { x: -4, y: 0 }, layer: "pcb" },
  { type: "move_component", component: "C1", center: { x: 4, y: 0 }, layer: "pcb" },
]

const build = (ops: Operation[]): Design => {
  const result = applyAll(createDesign("board"), ops)
  if (!result.ok) throw new Error(result.error.map((e) => e.message).join(" | "))
  return result.value
}

beforeEach(() => setIdFactory(createSequentialIdFactory()))

describe("routePcb", () => {
  it(
    "routes a board with real traces — M9's criterion",
    async () => {
      const result = await routePcb(build(TWO_PART_BOARD))

      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error(result.error.map((e) => e.message).join(" | "))

      // A trace with a route, not an empty placeholder.
      expect(result.value.traceCount).toBeGreaterThanOrEqual(1)
      expect(result.value.padCount).toBe(4)

      const trace = result.value.elements.find((e) => e.type === "pcb_trace") as unknown as {
        route?: unknown[]
      }
      expect(trace?.route?.length).toBeGreaterThan(0)

      // And a board to put it on.
      expect(result.value.elements.some((e) => e.type === "pcb_board")).toBe(true)
      expect(routingFailed(result.value)).toBe(false)
    },
    ROUTE_TIMEOUT,
  )

  it(
    "honours the placement the user chose",
    async () => {
      const result = await routePcb(build(TWO_PART_BOARD))
      if (!result.ok) throw new Error("routing failed")

      const components = result.value.elements.filter(
        (e) => e.type === "pcb_component",
      ) as unknown as Array<{ center: { x: number; y: number } }>

      // R1 at -4 and C1 at +4: the router places traces, not parts. A router that moved
      // a part the user positioned would make the PCB tab pointless.
      const xs = components.map((c) => c.center.x).sort((a, b) => a - b)
      expect(xs[0]).toBeCloseTo(-4, 1)
      expect(xs[xs.length - 1]).toBeCloseTo(4, 1)
    },
    ROUTE_TIMEOUT,
  )

  it(
    "produces conformant circuit-json",
    async () => {
      const result = await routePcb(build(TWO_PART_BOARD))
      if (!result.ok) throw new Error("routing failed")

      // The board layer goes into the document, so it is held to the same standard as
      // everything else (principle 2).
      expect(validateCircuit(result.value.elements).ok).toBe(true)
    },
    ROUTE_TIMEOUT,
  )

  it("refuses an empty design rather than making an empty board", async () => {
    const result = await routePcb(createDesign("empty"))

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error[0]?.code).toBe("LAYOUT_FAILED")
      expect(result.error[0]?.hint).toBeTruthy()
    }
  })

  it(
    "refuses a design whose components have no footprints",
    async () => {
      // A board with no pads exports Gerbers with no copper, and you find out at the fab
      // house. Failing here is the only useful outcome.
      const result = await routePcb(
        build([
          { type: "add_component", ftype: "simple_resistor", name: "R1", props: {} },
          { type: "add_component", ftype: "simple_resistor", name: "R2", props: {} },
          { type: "connect", a: { component: "R1", pin: 2 }, b: { component: "R2", pin: 1 } },
        ]),
      )

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error[0]?.message).toMatch(/no pads|no components/i)
    },
    ROUTE_TIMEOUT,
  )
})

describe("withRoutedPcb", () => {
  it(
    "replaces the board layer and leaves the schematic alone",
    async () => {
      const design = build(TWO_PART_BOARD)
      const routed = await routePcb(design)
      if (!routed.ok) throw new Error("routing failed")

      const updated = withRoutedPcb(design, routed.value)

      // The source layer is untouched — the board and the schematic are two views of one
      // document, and routing must not disturb the other one.
      const sourceBefore = design.circuit.filter((e) => e.type.startsWith("source_"))
      const sourceAfter = updated.circuit.filter((e) => e.type.startsWith("source_"))
      expect(sourceAfter).toEqual(sourceBefore)

      expect(updated.circuit.some((e) => e.type === "pcb_trace")).toBe(true)
      // And manual placements survive, because they live outside `circuit` entirely.
      expect(updated.manualEdits.pcb_placements).toHaveLength(2)
    },
    ROUTE_TIMEOUT,
  )

  it(
    "is idempotent — routing twice does not accumulate a second board",
    async () => {
      const design = build(TWO_PART_BOARD)
      const first = await routePcb(design)
      if (!first.ok) throw new Error("routing failed")

      const once = withRoutedPcb(design, first.value)
      const twice = withRoutedPcb(once, first.value)

      const boards = twice.circuit.filter((e) => e.type === "pcb_board")
      expect(boards).toHaveLength(1)
      expect(twice.circuit.length).toBe(once.circuit.length)
    },
    ROUTE_TIMEOUT,
  )
})
