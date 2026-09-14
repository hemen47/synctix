/**
 * ADR-0013's migration: v1 stored placement in `meta[id].layoutOverride`, v2 stores it
 * in `design.manualEdits` keyed by component name.
 */

import { beforeEach, describe, expect, it } from "vitest"
import { createSequentialIdFactory, setIdFactory } from "@syntrix/shared"
import { applyAll, createDesign } from "./apply"
import { buildIndex } from "./index-view"
import { migrateDesign, type StoredDesign } from "./migrate"
import type { Operation } from "./operations"

const twoResistors: Operation[] = [
  { type: "add_component", ftype: "simple_resistor", name: "R1", props: { resistance: "10k" } },
  { type: "add_component", ftype: "simple_resistor", name: "R2", props: { resistance: "1k" } },
]

/** A design as v1 would have written it: no `manualEdits`, placement in the sidecar. */
const v1Design = (): StoredDesign => {
  const result = applyAll(createDesign("d"), twoResistors)
  if (!result.ok) throw new Error(result.error.map((e) => e.message).join(" | "))
  const design = result.value
  const view = buildIndex(design.circuit)
  const r1 = view.componentsByName.get("R1")!.source_component_id
  const r2 = view.componentsByName.get("R2")!.source_component_id

  return {
    id: design.id,
    version: design.version,
    circuit: design.circuit,
    meta: {
      [r1]: { layoutOverride: { center: { x: 5, y: 10 }, pinned: true }, notes: ["keep me"] },
      [r2]: { layoutOverride: { center: { x: 20, y: 0 }, rotation: 90, pinned: true } },
    },
  }
}

describe("migrateDesign", () => {
  beforeEach(() => setIdFactory(createSequentialIdFactory()))

  it("moves v1 layout overrides into manualEdits, keyed by component name", () => {
    const { design, report } = migrateDesign(v1Design())

    expect(report.migrated).toBe(true)
    expect(report.placements.sort()).toEqual(["R1", "R2"])
    expect(design.manualEdits.schematic_placements).toEqual([
      { selector: "R1", relative_to: "group_center", center: { x: 5, y: 10 } },
      { selector: "R2", relative_to: "group_center", center: { x: 20, y: 0 } },
    ])
  })

  it("leaves the rest of the sidecar alone", () => {
    const stored = v1Design()
    const r1 = Object.keys(stored.meta)[0]!
    const { design } = migrateDesign(stored)

    expect(design.meta[r1]?.notes).toEqual(["keep me"])
    // The v1 field itself is gone — nothing should read it after the migration.
    expect(design.meta[r1]).not.toHaveProperty("layoutOverride")
  })

  it("keeps rotation in the sidecar, which manual-edits placements cannot carry", () => {
    const stored = v1Design()
    const r2 = Object.keys(stored.meta)[1]!
    const { design } = migrateDesign(stored)

    expect(design.meta[r2]?.rotationDeg).toBe(90)
  })

  it("drops a meta entry that held nothing but a layout override", () => {
    const stored = v1Design()
    const r2 = Object.keys(stored.meta)[1]!
    stored.meta[r2] = { layoutOverride: { center: { x: 1, y: 1 } } }
    const { design } = migrateDesign(stored)

    expect(design.meta[r2]).toBeUndefined()
  })

  it("reports an override whose component is gone rather than dropping it silently", () => {
    const stored = v1Design()
    stored.meta["source_component_gone"] = { layoutOverride: { center: { x: 1, y: 2 } } }

    const { report } = migrateDesign(stored)
    expect(report.orphaned).toEqual(["source_component_gone"])
  })

  it("is idempotent, so it is safe to run on every load", () => {
    const once = migrateDesign(v1Design())
    const twice = migrateDesign(once.design)

    expect(twice.design).toEqual(once.design)
    expect(twice.report.migrated).toBe(false)
  })

  it("leaves a v2 design untouched", () => {
    const result = applyAll(createDesign("d"), [
      ...twoResistors,
      { type: "move_component", component: "R1", center: { x: 3, y: 4 }, layer: "schematic" },
    ])
    if (!result.ok) throw new Error("setup failed")

    const { design, report } = migrateDesign(result.value)
    expect(report.migrated).toBe(false)
    expect(design).toEqual(result.value)
  })
})
