/**
 * Layout plugin contract.
 *
 * The LLM gives semantic hints; a strategy turns them into coordinates (principle 4).
 * A strategy reads `meta.constraints` and `design.manualEdits` and returns positioned
 * schematic elements — it never edits the source graph.
 */

import type { Design } from "@syntrix/core"
import type { AnyCircuitElement } from "circuit-json"
import type { Result, ValidationError } from "@syntrix/shared"

export interface LayoutOptions {
  /**
   * Grid pitch in mm. 1.27 (50 mil) is the schematic convention and what the editor
   * snaps to.
   */
  gridMm?: number
  /** Minimum clear space between symbol bounding boxes, in mm. */
  spacingMm?: number
  /**
   * Only position elements that have no position yet, leaving settled parts of the
   * schematic alone. This is what makes adding one component to a large design not
   * rearrange the whole drawing.
   */
  incremental?: boolean
  /**
   * Draw power and ground as net labels rather than routing wires to a distant rail.
   * A schematic with a wire from every IC to one VCC symbol is correct and unreadable.
   */
  useNetLabelsForPower?: boolean
  direction?: "RIGHT" | "DOWN"
}

export interface LayoutResult {
  /**
   * schematic_component, schematic_port, schematic_trace, schematic_net_label and
   * friends. The caller replaces the design's schematic layer with these.
   */
  elements: AnyCircuitElement[]
  /** Bounding box of the drawing in mm, for initial viewport fit. */
  bounds: { minX: number; minY: number; maxX: number; maxY: number }
  /** Constraints the strategy could not satisfy, reported rather than silently dropped. */
  unsatisfiedConstraints: Array<{ component: string; reason: string }>
}

export interface LayoutStrategy {
  id: string
  label: string
  layout(design: Design, options?: LayoutOptions): Promise<Result<LayoutResult, ValidationError[]>>
}

export interface LayoutStrategyRegistry {
  register(strategy: LayoutStrategy): void
  get(id: string): LayoutStrategy | undefined
  list(): LayoutStrategy[]
}

/** Which side of a symbol a pin belongs on, by its electrical role. */
export type PortSide = "north" | "south" | "east" | "west"

export interface SymbolConventions {
  /** Inputs west, outputs east, power north, ground south. */
  sideForPin(kind: string, functions: string[]): PortSide
  /** Passives sit inline with the signal flow rather than being boxed. */
  isInlinePassive(ftype: string): boolean
}
