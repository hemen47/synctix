/**
 * One-time migration of v1 documents into the v2 shape.
 *
 * v1 stored user placement as `meta[elementId].layoutOverride` — our own convention,
 * keyed by `source_component_id`, readable by nothing outside SYNTRIX. v2 stores it in
 * `design.manualEdits`, tscircuit's own shape, keyed by component name (ADR-0013).
 *
 * This runs when a design is loaded, not as a batch script, so a design written before
 * the migration and never opened since still comes back correct.
 */

import type { AnyCircuitElement } from "circuit-json"
import type { Design, MetaEntry } from "./types"
import { emptyManualEdits, setPlacement, type ManualEdits } from "./manual-edits"

/** The v1 sidecar field, kept only so the migration can read documents that have it. */
export interface LegacyLayoutOverride {
  center?: { x: number; y: number }
  rotation?: number
  pinned?: boolean
}

interface LegacyMetaEntry extends MetaEntry {
  layoutOverride?: LegacyLayoutOverride
}

/** A design as it may arrive from storage: v1 or v2 shaped. */
export type StoredDesign = Omit<Design, "manualEdits" | "meta"> & {
  manualEdits?: ManualEdits
  meta: Record<string, LegacyMetaEntry>
}

export interface MigrationReport {
  migrated: boolean
  /** Component names whose placement moved from `meta` into `manualEdits`. */
  placements: string[]
  /**
   * Overrides that could not be migrated because their element is no longer in the
   * document. Reported rather than dropped silently.
   */
  orphaned: string[]
}

const componentNameById = (circuit: AnyCircuitElement[]): Map<string, string> => {
  const names = new Map<string, string>()
  for (const element of circuit) {
    if (element.type === "source_component" && element.name) {
      names.set(element.source_component_id, element.name)
    }
  }
  return names
}

/**
 * Bring a stored design up to the v2 shape.
 *
 * Idempotent: a design that already has `manualEdits` and no `layoutOverride` comes back
 * unchanged with `migrated: false`, so this is safe to call on every load.
 */
export const migrateDesign = (
  stored: StoredDesign,
): { design: Design; report: MigrationReport } => {
  const names = componentNameById(stored.circuit)

  let manualEdits: ManualEdits = stored.manualEdits ?? emptyManualEdits()
  const meta: Record<string, MetaEntry> = {}
  const placements: string[] = []
  const orphaned: string[] = []

  for (const [elementId, entry] of Object.entries(stored.meta)) {
    const { layoutOverride, ...rest } = entry

    if (layoutOverride?.center) {
      const name = names.get(elementId)
      if (name) {
        // v1 rotation has nowhere to go in tscircuit's manual-edits shape, which carries
        // placement only. It stays in the sidecar, where it was always genuinely ours.
        manualEdits = setPlacement(manualEdits, "schematic", name, layoutOverride.center)
        placements.push(name)
      } else {
        orphaned.push(elementId)
      }
    }

    const rotation = layoutOverride?.rotation
    const migratedEntry: MetaEntry = {
      ...rest,
      ...(rotation !== undefined ? { rotationDeg: rotation } : {}),
    }
    // Drop an entry that held nothing but a layout override. Only such an entry, though:
    // pruning every empty entry would make this more than a migration, and it would stop
    // being a no-op on a design that has already been migrated.
    if (layoutOverride && Object.keys(migratedEntry).length === 0) continue
    meta[elementId] = migratedEntry
  }

  return {
    design: { ...stored, meta, manualEdits },
    report: {
      migrated: placements.length > 0 || orphaned.length > 0 || stored.manualEdits === undefined,
      placements,
      orphaned,
    },
  }
}
