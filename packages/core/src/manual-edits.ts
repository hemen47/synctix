/**
 * Manual edits — placements a human chose, which automatic layout must never overwrite.
 *
 * This is **not our schema**. `@tscircuit/props` exports `manual_edits_file`, the same
 * shape tscircuit reads from a project's `manual-edits.json`, and we use it verbatim so
 * a SYNTRIX design's placements mean something to the rest of the toolchain rather than
 * being a private convention (ADR-0013).
 *
 * The real shape, verified against `@tscircuit/props@0.0.653`:
 *
 * ```
 * { pcb_placements?:       { selector, relative_to, center: {x,y} }[]
 *   schematic_placements?: { selector, relative_to, center: {x,y} }[]
 *   manual_trace_hints?:   { pcb_port_selector, offsets: Point[] }[] }
 * ```
 *
 * Note what the key is: a **selector** — a component name such as `"R1"`, or a tscircuit
 * selector path — not a `source_component_id`. tscircuit matches with
 * `matchesSelector(component, placement.selector) || component.props.name === selector`.
 * Ids are regenerated whenever a design is re-evaluated from TSX; names survive that, so
 * keying by name is what makes a user's drag outlive a re-compile.
 */

import { manual_edits_file } from "@tscircuit/props"
import type { z } from "zod"

export const manualEditsSchema = manual_edits_file

/** The parsed form: every `relative_to` filled in, every coordinate a number. */
export type ManualEdits = z.output<typeof manual_edits_file>
export type ManualEditsInput = z.input<typeof manual_edits_file>

export type PlacementLayer = "schematic" | "pcb"

export interface Placement {
  selector: string
  relative_to: string
  center: { x: number; y: number }
}

/** A design with nothing dragged yet. Both arrays stay absent rather than empty. */
export const emptyManualEdits = (): ManualEdits => ({})

const listKey = (layer: PlacementLayer) =>
  layer === "schematic" ? ("schematic_placements" as const) : ("pcb_placements" as const)

/** The placements for one layer, or an empty list when that layer has none. */
export const placementsFor = (edits: ManualEdits, layer: PlacementLayer): Placement[] =>
  edits[listKey(layer)] ?? []

/**
 * Look one up. Matching is by exact selector — a component name, in practice, since that
 * is what `move_component` writes.
 */
export const findPlacement = (
  edits: ManualEdits,
  layer: PlacementLayer,
  selector: string,
): Placement | undefined => placementsFor(edits, layer).find((p) => p.selector === selector)

/**
 * Record a placement, replacing any previous one for the same selector.
 *
 * Immutable, like everything else in core: the caller gets a new object and the original
 * is untouched.
 */
export const setPlacement = (
  edits: ManualEdits,
  layer: PlacementLayer,
  selector: string,
  center: { x: number; y: number },
  relativeTo = "group_center",
): ManualEdits => {
  const key = listKey(layer)
  const existing = edits[key] ?? []
  const next: Placement = { selector, relative_to: relativeTo, center }
  const index = existing.findIndex((p) => p.selector === selector)

  return {
    ...edits,
    [key]: index >= 0 ? existing.map((p, i) => (i === index ? next : p)) : [...existing, next],
  }
}

/** Drop a placement, so the element falls back under automatic layout. */
export const clearPlacement = (
  edits: ManualEdits,
  layer: PlacementLayer,
  selector: string,
): ManualEdits => {
  const key = listKey(layer)
  const existing = edits[key]
  if (!existing) return edits

  const remaining = existing.filter((p) => p.selector !== selector)
  if (remaining.length === existing.length) return edits
  // An empty list would serialise as `"schematic_placements": []`, which reads as "the
  // user pinned nothing here" rather than "this layer was never touched". Drop the key.
  if (remaining.length === 0) {
    const { [key]: _removed, ...rest } = edits
    return rest
  }
  return { ...edits, [key]: remaining }
}
