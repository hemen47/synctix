/**
 * Hit testing and snapping.
 *
 * Pure geometry, deliberately. These are the functions that decide whether a click
 * started a wire or selected a symbol, and getting them wrong makes an editor feel
 * broken in a way no amount of visual polish hides — so they are testable without a DOM.
 *
 * Everything is in world millimetres. The caller converts from pixels first, which is why
 * tolerances are given in mm and scaled by the zoom level rather than fixed in pixels: a
 * pin must stay clickable when zoomed out, and must not swallow a click on a nearby wire
 * when zoomed in.
 */

import type { HitResult, PinNode, Point, Scene, SceneNode, SymbolNode, WireNode } from "./types"

/** Grid pitch: 50 mil, the schematic convention and what every symbol's pins sit on. */
export const GRID_MM = 1.27

export interface HitOptions {
  /**
   * How close counts as a hit, in mm. Scaled by the caller from the zoom level so the
   * target stays roughly constant in pixels.
   */
  toleranceMm?: number
  /** Restrict the search, e.g. to pins while a wire is being drawn. */
  kinds?: Array<SceneNode["kind"]>
}

const DEFAULT_TOLERANCE_MM = 1.0

/**
 * What is under a point, nearest first.
 *
 * Pins beat wires beat labels beat symbols at equal distance. That order is not
 * arbitrary: a pin sits on top of its own symbol and is the smaller target, so a symbol
 * winning the tie would make pins unclickable; and a wire ending at a pin should still
 * let you grab the pin to start a new branch.
 */
export const hitTest = (scene: Scene, at: Point, options: HitOptions = {}): HitResult[] => {
  const tolerance = options.toleranceMm ?? DEFAULT_TOLERANCE_MM
  const wanted = options.kinds
  const results: HitResult[] = []

  const want = (kind: SceneNode["kind"]): boolean => !wanted || wanted.includes(kind)

  if (want("pin")) {
    for (const symbol of scene.symbols) {
      for (const pin of symbol.pins) {
        const distance = Math.hypot(pin.at.x - at.x, pin.at.y - at.y)
        if (distance <= tolerance) results.push({ node: pin, distance })
      }
    }
  }

  if (want("wire")) {
    for (const wire of scene.wires) {
      const distance = distanceToPolyline(at, wire.points)
      if (distance <= tolerance) results.push({ node: wire, distance })
    }
  }

  if (want("label")) {
    for (const label of scene.labels) {
      // A label's clickable area is its anchor, not its rendered text: text metrics need
      // a DOM, and this module deliberately does not have one.
      const distance = Math.hypot(label.at.x - at.x, label.at.y - at.y)
      if (distance <= tolerance * 1.5) results.push({ node: label, distance })
    }
  }

  if (want("symbol")) {
    for (const symbol of scene.symbols) {
      const distance = distanceToRect(at, symbol.bounds)
      if (distance <= tolerance) results.push({ node: symbol, distance })
    }
  }

  return results.sort((a, b) => a.distance - b.distance || rank(a.node) - rank(b.node))
}

/** The first hit, or nothing. */
export const hitOne = (scene: Scene, at: Point, options?: HitOptions): SceneNode | undefined =>
  hitTest(scene, at, options)[0]?.node

const RANK: Record<SceneNode["kind"], number> = { pin: 0, wire: 1, label: 2, symbol: 3 }
const rank = (node: SceneNode): number => RANK[node.kind]

/** Distance to a rectangle: 0 inside, the perpendicular gap outside. */
export const distanceToRect = (
  at: Point,
  rect: { center: Point; width: number; height: number },
): number => {
  const dx = Math.max(Math.abs(at.x - rect.center.x) - rect.width / 2, 0)
  const dy = Math.max(Math.abs(at.y - rect.center.y) - rect.height / 2, 0)
  return Math.hypot(dx, dy)
}

/** Distance to the nearest point on a polyline. */
export const distanceToPolyline = (at: Point, points: Point[]): number => {
  if (points.length === 0) return Infinity
  if (points.length === 1) return Math.hypot(points[0]!.x - at.x, points[0]!.y - at.y)

  let best = Infinity
  for (let i = 0; i < points.length - 1; i += 1) {
    best = Math.min(best, distanceToSegment(at, points[i]!, points[i + 1]!))
  }
  return best
}

export const distanceToSegment = (at: Point, a: Point, b: Point): number => {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSq = dx * dx + dy * dy
  if (lengthSq === 0) return Math.hypot(at.x - a.x, at.y - a.y)

  // Projection of `at` onto the segment, clamped to its ends.
  const t = Math.max(0, Math.min(1, ((at.x - a.x) * dx + (at.y - a.y) * dy) / lengthSq))
  return Math.hypot(at.x - (a.x + t * dx), at.y - (a.y + t * dy))
}

/** Snap to the schematic grid. Every placement goes through this. */
export const snapToGrid = (at: Point, gridMm = GRID_MM): Point => ({
  x: Math.round(at.x / gridMm) * gridMm,
  y: Math.round(at.y / gridMm) * gridMm,
})

/**
 * Where a wire being drawn should attach.
 *
 * A nearby pin wins over the grid, and by a wider margin than a plain hit test would
 * give it: a wire that lands one grid step away from a pin looks connected and is not,
 * which is the single most common way a schematic drawn by hand is wrong.
 */
export const snapForWiring = (
  scene: Scene,
  at: Point,
  options: { pinToleranceMm?: number; gridMm?: number } = {},
): { point: Point; pin?: PinNode } => {
  const tolerance = options.pinToleranceMm ?? GRID_MM * 1.5
  let nearest: { pin: PinNode; distance: number } | undefined

  for (const symbol of scene.symbols) {
    for (const pin of symbol.pins) {
      const distance = Math.hypot(pin.at.x - at.x, pin.at.y - at.y)
      if (distance <= tolerance && (!nearest || distance < nearest.distance)) {
        nearest = { pin, distance }
      }
    }
  }

  return nearest
    ? { point: nearest.pin.at, pin: nearest.pin }
    : { point: snapToGrid(at, options.gridMm) }
}

/**
 * The orthogonal path between two points.
 *
 * Two segments with one corner. Which axis goes first is chosen by the longer span, so
 * the wire leaves the pin in the direction it was already heading rather than making an
 * immediate right angle.
 */
export const orthogonalRoute = (from: Point, to: Point): Point[] => {
  if (Math.abs(from.x - to.x) < 1e-9 || Math.abs(from.y - to.y) < 1e-9) return [from, to]

  return Math.abs(to.x - from.x) >= Math.abs(to.y - from.y)
    ? [from, { x: to.x, y: from.y }, to]
    : [from, { x: from.x, y: to.y }, to]
}

/** Everything inside a rubber-band selection, by symbol. */
export const symbolsInRect = (scene: Scene, a: Point, b: Point): SymbolNode[] => {
  const minX = Math.min(a.x, b.x)
  const maxX = Math.max(a.x, b.x)
  const minY = Math.min(a.y, b.y)
  const maxY = Math.max(a.y, b.y)

  // Centre-inside rather than fully-enclosed: dragging a box across a row of parts should
  // take the ones it crosses, which is what every schematic editor does.
  return scene.symbols.filter(
    (s) =>
      s.bounds.center.x >= minX &&
      s.bounds.center.x <= maxX &&
      s.bounds.center.y >= minY &&
      s.bounds.center.y <= maxY,
  )
}

/** Which wires touch a point — used to decide whether a junction dot is needed. */
export const wiresAt = (scene: Scene, at: Point, toleranceMm = 0.01): WireNode[] =>
  scene.wires.filter((wire) => distanceToPolyline(at, wire.points) <= toleranceMm)
