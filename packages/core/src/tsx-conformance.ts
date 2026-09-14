/**
 * Making tscircuit's output fit the spec, and surfacing what it complained about.
 *
 * Separate from `compileTsx` (which lives in `./tsx`) because nothing here needs
 * `@tscircuit/eval`. That matters: `@tscircuit/eval` drags the whole tscircuit render
 * stack into anything that so much as imports its types, and the browser bundle imports
 * `@syntrix/core`. The browser never compiles TSX — ADR-0015 says untrusted TSX needs a
 * process boundary, which a browser tab is the wrong side of — so it should not pay for
 * the render stack either, in bytes or in compile time.
 */

import type { AnyCircuitElement } from "circuit-json"
import type { Result, ValidationError } from "@syntrix/shared"
import { ok } from "@syntrix/shared"
import { circuitJsonElementTypes, elementSchemaFor, validateCircuit } from "./elements"

export interface TsxDiagnostic {
  severity: "error" | "warning"
  /** The circuit-json element type that carried it, e.g. source_trace_not_connected_error. */
  type: string
  message: string
}

/**
 * Pull tscircuit's own problem reports out of a rendered document.
 *
 * circuit-json models them as elements whose type ends in `_error` or `_warning`, each
 * carrying a human-readable `message`. They stay in the document — they are valid
 * elements, and the UI draws them — but they are also lifted out here so a caller does
 * not have to know that convention to find out the render went wrong.
 */
export const collectDiagnostics = (elements: AnyCircuitElement[]): TsxDiagnostic[] => {
  const diagnostics: TsxDiagnostic[] = []
  for (const element of elements) {
    const severity = element.type.endsWith("_error")
      ? ("error" as const)
      : element.type.endsWith("_warning")
        ? ("warning" as const)
        : undefined
    if (!severity) continue

    const message = (element as unknown as Record<string, unknown>)["message"]
    diagnostics.push({
      severity,
      type: element.type,
      message: typeof message === "string" ? message : element.type,
    })
  }
  return diagnostics
}

/** Did the render report something that means the circuit is actually wrong? */
export const hasErrors = (diagnostics: TsxDiagnostic[]): boolean =>
  diagnostics.some((d) => d.severity === "error")

export interface SpecSkew {
  /** Element types the schema does not know, with how many of each were dropped. */
  droppedElements: Array<{ type: string; count: number }>
  /** Fields the schema rejected, stripped so the element itself could be kept. */
  strippedFields: Array<{ type: string; field: string; count: number }>
}

export const noSkew = (): SpecSkew => ({ droppedElements: [], strippedFields: [] })

export const hasSkew = (skew: SpecSkew): boolean =>
  skew.droppedElements.length > 0 || skew.strippedFields.length > 0

/**
 * Split what tscircuit rendered into what the spec accepts and what it does not.
 *
 * These should be the same set, and very nearly are. `@tscircuit/core`'s renderer and
 * `circuit-json`'s schema ship from the same project but not in lockstep, and at
 * `circuit-json@0.0.491` — the latest published version — they disagree about one field:
 * `pcb_component.display_offset_x` comes back as a number where the schema declares a
 * string. One malformed field per placed component is enough to reject the element, and
 * rejecting the element is enough to fail the whole compile.
 *
 * So two kinds of divergence are handled, in order of how much is at stake:
 *
 * 1. **A field the element's own schema rejects** is stripped and the element kept. The
 *    element is real and wanted; only that field is not representable.
 * 2. **An element type the union does not know at all** is dropped whole. Nothing hits
 *    this today — every type the renderer emits is in the union — but a renderer that
 *    runs ahead of its schema once will do it again, and failing every TSX compile until
 *    a dependency bump is not a reasonable response to a new element type.
 *
 * Principle 2 decides both: the document is circuit-json validated by circuit-json's own
 * schemas, so nothing the schema rejects may enter — not even something tscircuit itself
 * produced. The alternative to dropping would be either failing every compile over a
 * display offset, or smuggling unvalidated data into the document. Neither is acceptable;
 * dropping and reporting what was dropped is.
 *
 * An element of a known type that is malformed in a way stripping cannot fix is a real
 * error and still fails the compile.
 */
export const partitionConformant = (
  elements: unknown[],
): Result<{ elements: AnyCircuitElement[]; skew: SpecSkew }, ValidationError[]> => {
  const known = circuitJsonElementTypes()
  const kept: unknown[] = []
  const droppedElements = new Map<string, number>()
  const strippedFields = new Map<string, number>()

  for (const element of elements) {
    const type = (element as { type?: string })?.type
    if (typeof type === "string" && !known.has(type)) {
      droppedElements.set(type, (droppedElements.get(type) ?? 0) + 1)
      continue
    }

    const repaired = stripRejectedFields(element)
    for (const field of repaired.stripped) {
      const key = `${type}.${field}`
      strippedFields.set(key, (strippedFields.get(key) ?? 0) + 1)
    }
    kept.push(repaired.element)
  }

  // Whatever survived still goes through the full schema. If stripping did not make an
  // element valid, it fails here, loudly, with the element index and the reason.
  const validated = validateCircuit(kept)
  if (!validated.ok) return validated

  return ok({
    elements: validated.value,
    skew: {
      droppedElements: [...droppedElements].map(([type, count]) => ({ type, count })),
      strippedFields: [...strippedFields].map(([key, count]) => {
        const dot = key.lastIndexOf(".")
        return { type: key.slice(0, dot), field: key.slice(dot + 1), count }
      }),
    },
  })
}

/**
 * Try to make one element pass by removing the fields its own schema objects to.
 *
 * Only ever removes: nothing is coerced or invented. A required field cannot be fixed
 * this way — removing it just fails validation again — so this can only rescue an element
 * whose problem is an optional field the renderer spells differently, which is exactly
 * the skew being worked around.
 */
const stripRejectedFields = (element: unknown): { element: unknown; stripped: string[] } => {
  const type = (element as { type?: string })?.type
  if (!type || !element || typeof element !== "object") return { element, stripped: [] }

  const schema = elementSchemaFor(type)
  if (!schema) return { element, stripped: [] }

  const parsed = schema.safeParse(element)
  if (parsed.success) return { element, stripped: [] }

  // Top-level fields this element's own schema rejected. Nested paths are left alone: a
  // bad field inside a nested object is a real structural problem, not a spelling skew.
  const offenders = new Set<string>()
  for (const issue of parsed.error.issues) {
    const path = issue.path ?? []
    if (path.length === 1 && typeof path[0] === "string" && path[0] !== "type") {
      offenders.add(path[0])
    }
  }
  if (offenders.size === 0) return { element, stripped: [] }

  const record = { ...(element as Record<string, unknown>) }
  const stripped: string[] = []
  for (const field of offenders) {
    if (!(field in record)) continue
    delete record[field]
    stripped.push(field)
  }

  // Only claim a repair if it worked. Otherwise hand back the original, so the error the
  // caller sees describes the real element rather than our mangled copy.
  return schema.safeParse(record).success
    ? { element: record, stripped }
    : { element, stripped: [] }
}
