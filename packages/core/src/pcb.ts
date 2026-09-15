/**
 * The PCB layer: a board, placement, and routing done by tscircuit.
 *
 * We do not write a router (ADR-0012). `@tscircuit/core` has one, and the way to reach it
 * is the path already built for TSX mode: eject the design to tscircuit source with its
 * PCB placements, evaluate it, and take the `pcb_*` elements that come back — `pcb_board`,
 * pads, silkscreen, courtyards and `pcb_trace`. Verified end to end: two 0402 parts and
 * one trace produce a routed board with a `pcb_trace` carrying a real route.
 *
 * That reuse is the whole design. A second implementation of placement-to-geometry would
 * be a second thing to disagree with the schematic, and routing is the part of EDA where
 * "nearly right" is indistinguishable from broken.
 *
 * Lives behind `@syntrix/core/tsx` because it needs `compileTsx`, which the browser must
 * never load.
 */

import type { AnyCircuitElement } from "circuit-json"
import type { Result, ValidationError } from "@syntrix/shared"
import { err, ok, validationError } from "@syntrix/shared"
import type { Design } from "./types"
import { ejectToTsx } from "./eject-tsx"
import { buildIndex } from "./index-view"
import { compileTsx } from "./tsx"
import { hasErrors, type TsxDiagnostic } from "./tsx-conformance"

export interface RouteOptions {
  /** Board outline in mm. Inferred from the placement when omitted. */
  board?: { width: number; height: number }
  /** Routing can take a while on a dense board. */
  timeoutMs?: number
}

export interface RoutedPcb {
  /** Only the `pcb_*` and `cad_component` elements — the board layer, nothing else. */
  elements: AnyCircuitElement[]
  traceCount: number
  padCount: number
  /** What tscircuit complained about without throwing (ADR-0017). */
  diagnostics: TsxDiagnostic[]
}

/**
 * Route the board.
 *
 * Fails rather than returning an empty board when nothing was routed: a caller that gets
 * `ok` with no traces will export Gerbers of a board with no copper on it, and find out
 * at the fab house.
 */
export const routePcb = async (
  design: Design,
  options: RouteOptions = {},
): Promise<Result<RoutedPcb, ValidationError[]>> => {
  const view = buildIndex(design.circuit)
  if (view.components.size === 0) {
    return err([
      validationError(
        "LAYOUT_FAILED",
        "The design has no components to place on a board.",
        "Add components and connect them before routing.",
      ),
    ])
  }

  const { code, limitations } = ejectToTsx(design, {
    ...(options.board ? { board: options.board } : {}),
    name: "Board",
  })

  const compiled = await compileTsx(wrapForEval(code), {
    timeoutMs: options.timeoutMs ?? 60_000,
    name: "pcb-route",
  })
  if (!compiled.ok) return compiled

  const elements = compiled.value.elements.filter(
    (element) => element.type.startsWith("pcb_") || element.type === "cad_component",
  )

  const traceCount = elements.filter((e) => e.type === "pcb_trace").length
  const padCount = elements.filter(
    (e) => e.type === "pcb_smtpad" || e.type === "pcb_plated_hole",
  ).length

  if (padCount === 0) {
    return err([
      validationError(
        "LAYOUT_FAILED",
        "Routing produced a board with no pads.",
        "Every component needs a footprint before it can be placed. Components exported " +
          `without one: ${limitations.join("; ") || "none reported"}`,
      ),
    ])
  }

  return ok({
    elements,
    traceCount,
    padCount,
    diagnostics: compiled.value.diagnostics,
  })
}

/**
 * Replace a design's board layer with a freshly routed one.
 *
 * The schematic layer is untouched: the two are different views of one document, and a
 * relayout of the board must not move a symbol the user placed.
 */
export const withRoutedPcb = (design: Design, routed: RoutedPcb): Design => ({
  ...design,
  circuit: [
    ...design.circuit.filter(
      (element) => !element.type.startsWith("pcb_") && element.type !== "cad_component",
    ),
    ...routed.elements,
  ],
})

/** Whether the router reported something that means the board is wrong. */
export const routingFailed = (routed: RoutedPcb): boolean => hasErrors(routed.diagnostics)

/** `ejectToTsx` writes a module; the evaluator wants the JSX added to `circuit`. */
const wrapForEval = (code: string): string => {
  const start = code.indexOf("<board")
  const end = code.lastIndexOf("</board>") + "</board>".length
  return `circuit.add(${code.slice(start, end)})`
}
