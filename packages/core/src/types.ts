/**
 * The design document.
 *
 * `circuit` is pure, spec-conformant circuit-json — a flat array validated by the
 * `circuit-json` package's `any_circuit_element` union (a strict discriminated union on
 * `type`, see ADR-0003). Nothing non-spec ever goes in it.
 *
 * Anything we need that the spec does not model goes in `meta`, keyed by element id —
 * with one exception. Placements a human chose live in `manualEdits`, which is
 * tscircuit's own `manual-edits.json` shape rather than ours, so they mean something to
 * the rest of the toolchain (ADR-0013).
 */

import type { AnyCircuitElement } from "circuit-json"
import type { ManualEdits } from "./manual-edits"

export interface Design {
  id: string
  /** Monotonic, for optimistic concurrency. Incremented by every applied operation. */
  version: number
  circuit: AnyCircuitElement[]
  meta: Record<string, MetaEntry>
  /**
   * Schematic and PCB placements the user dragged, keyed by component name. Always wins
   * over automatic layout. Separate from `meta` because the shape is tscircuit's, not
   * ours: `@tscircuit/props`' `manual_edits_file`.
   */
  manualEdits: ManualEdits
}

/**
 * Sidecar data for one element. Every field is ours; none of it is circuit-json.
 */
export interface MetaEntry {
  /** Which part definition produced this element, if any. */
  partRef?: string
  /**
   * Symbol rotation in degrees. Placement lives in `design.manualEdits`, but tscircuit's
   * manual-edits shape carries position only, so rotation stays here where it has always
   * genuinely been ours.
   */
  rotationDeg?: number
  /** Semantic placement intent recorded by `place_hint`. The LLM writes these. */
  constraints?: PlacementConstraint[]
  /** Where this element came from — agent turn, import, user action. */
  provenance?: Provenance
  /** Free-form notes the agent attaches for later turns to read. */
  notes?: string[]
  /** Footprint trust, surfaced in BOM and enforced by agent house rules. */
  footprintVerification?: "verified" | "unverified"
}

export type PlacementConstraint =
  | { kind: "near"; target: string; maxDistanceMm?: number }
  | { kind: "side"; of: string; side: "north" | "south" | "east" | "west" }
  | { kind: "align"; with: string; axis: "x" | "y" }
  | { kind: "group"; groupId: string }
  | { kind: "decoupling_for"; component: string; pin: string }

export interface Provenance {
  source: "user" | "agent" | "import" | "layout" | "tsx"
  /** Operation id that created the element — the link back into the event log. */
  operationId?: string
  /** Agent run id, when `source` is "agent". */
  runId?: string
  at: string
}

/** A reference to one pin of one component, as the agent and API address it. */
export interface PortRef {
  /** Component name (refdes, e.g. "U1") or source_component_id. */
  component: string
  /** Pin number, pin name, or a known alternate name ("VCC", "3", "OUT"). */
  pin: string | number
}

export interface NetRef {
  net: string
}

export const isPortRef = (r: PortRef | NetRef): r is PortRef =>
  typeof (r as PortRef).component === "string"

export const isNetRef = (r: PortRef | NetRef): r is NetRef => typeof (r as NetRef).net === "string"
