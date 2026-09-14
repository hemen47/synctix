/**
 * The design document.
 *
 * `circuit` is pure, spec-conformant circuit-json — a flat array validated by the
 * `circuit-json` package's `any_circuit_element` union (a strict discriminated union on
 * `type`, see ADR-0003). Nothing non-spec ever goes in it.
 *
 * Anything we need that the spec does not model goes in `meta`, keyed by element id.
 */

import type { AnyCircuitElement } from "circuit-json"

export interface Design {
  id: string
  /** Monotonic, for optimistic concurrency. Incremented by every applied operation. */
  version: number
  circuit: AnyCircuitElement[]
  meta: Record<string, MetaEntry>
}

/**
 * Sidecar data for one element. Every field is ours; none of it is circuit-json.
 */
export interface MetaEntry {
  /** Which part definition produced this element, if any. */
  partRef?: string
  /** User or layout-engine position overrides. Manual overrides always win a relayout. */
  layoutOverride?: LayoutOverride
  /** Semantic placement intent recorded by `place_hint`. The LLM writes these. */
  constraints?: PlacementConstraint[]
  /** Where this element came from — agent turn, import, user action. */
  provenance?: Provenance
  /** Free-form notes the agent attaches for later turns to read. */
  notes?: string[]
  /** Footprint trust, surfaced in BOM and enforced by agent house rules. */
  footprintVerification?: "verified" | "unverified"
}

export interface LayoutOverride {
  center?: { x: number; y: number }
  rotation?: number
  /** True when a human moved it. Layout must not overwrite these. */
  pinned?: boolean
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

export const isNetRef = (r: PortRef | NetRef): r is NetRef =>
  typeof (r as NetRef).net === "string"
