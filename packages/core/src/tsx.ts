/**
 * The TSX bridge — how TSX mode lands.
 *
 * The LLM writes a tscircuit `<board>` against the official tscircuit skill; this module
 * evaluates it and hands the result to `merge_circuit_json`, the one validated door into
 * the document. TSX is an **input** format, never a stored one: the document is always
 * circuit-json (principle 3).
 *
 * `@tscircuit/eval`'s Node API, verified against 0.0.1402:
 *
 * ```ts
 * const runner = new CircuitRunner({ snippetsApiBaseUrl, cjsRegistryUrl })
 * await runner.setDisableCdnLoading(true)   // no npm resolution over the network
 * await runner.execute(code)                // `circuit` is in scope, JSX is pre-supplied
 * await runner.renderUntilSettled()
 * const elements = await runner.getCircuitJson()
 * await runner.kill()
 * ```
 *
 * Sandboxing is defence in depth rather than a single wall — see `compileTsx` below.
 */

import type { AnyCircuitElement } from "circuit-json"
import type { Result, ValidationError } from "@syntrix/shared"
import { err, ok, validationError } from "@syntrix/shared"
import { circuitJsonElementTypes, elementSchemaFor, validateCircuit } from "./elements"

export interface CompileTsxOptions {
  /** Abandon the evaluation after this long. Defaults to 20s. */
  timeoutMs?: number
  /**
   * Allow the sandbox to resolve npm imports from the jsDelivr CDN. Off by default: a
   * model-authored import is not a reason to reach the network.
   */
  allowCdn?: boolean
  /** Label used in error messages and in tscircuit's own logs. */
  name?: string
}

export interface CompiledTsx {
  elements: AnyCircuitElement[]
  /**
   * Problems tscircuit reported without throwing. **Read these.**
   *
   * A selector that matches nothing does not fail the render: tscircuit emits a
   * `source_trace_not_connected_error` element and carries on, so a caller that only
   * checks whether `compileTsx` returned ok will happily merge a board whose traces went
   * nowhere. Errors are the ones that mean the circuit is wrong; warnings are style and
   * completeness notes.
   */
  diagnostics: TsxDiagnostic[]
  /**
   * Where tscircuit's renderer and `circuit-json`'s schema disagreed, and what we did
   * about it. Empty in the normal case — see `partitionConformant`.
   */
  skew: SpecSkew
  /** How long the evaluation took, for the agent trace. */
  durationMs: number
}

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

const COMPILE_TIMEOUT_MS = 20_000

/**
 * Turn tscircuit TSX into circuit-json.
 *
 * Never throws: a syntax error, a bad selector or a timeout all come back as
 * `ValidationError[]` with the compiler's own message in `message` and the remedy in
 * `hint`, because the caller is usually a model that has to fix its own code.
 *
 * **On isolation.** `@tscircuit/eval` runs the code in this process, so the sandbox is
 * not a security boundary on its own. What is enforced here: CDN loading is off by
 * default, so the code cannot pull arbitrary npm packages; a timeout bounds a runaway
 * render; and the runner is always killed, including on the failure path. Untrusted
 * input (an MCP client, a public deployment) must additionally run this behind a
 * process boundary with its own resource limits — see ADR-0015.
 */
export const compileTsx = async (
  code: string,
  options: CompileTsxOptions = {},
): Promise<Result<CompiledTsx, ValidationError[]>> => {
  if (code.trim().length === 0) {
    return err([
      validationError(
        "TSX_COMPILE_FAILED",
        "No TSX code was supplied.",
        "Write a tscircuit <board> and pass it as `code`.",
      ),
    ])
  }

  const timeoutMs = options.timeoutMs ?? COMPILE_TIMEOUT_MS
  const started = Date.now()

  // Imported lazily: @tscircuit/eval pulls in the whole tscircuit render stack, and a
  // process that never compiles TSX should not pay for it.
  const { CircuitRunner } = await import("@tscircuit/eval")
  const runner = new CircuitRunner({ snippetsApiBaseUrl: "", cjsRegistryUrl: "" })

  try {
    await runner.setDisableCdnLoading(!options.allowCdn)

    const elements = await withTimeout(
      (async () => {
        await runner.execute(code, options.name ? { name: options.name } : undefined)
        await runner.renderUntilSettled()
        return runner.getCircuitJson()
      })(),
      timeoutMs,
    )

    if (elements.length === 0) {
      return err([
        validationError(
          "TSX_COMPILE_FAILED",
          "The code evaluated but produced no circuit elements.",
          "Make sure the snippet calls `circuit.add(<board>…</board>)` — defining a " +
            "component without adding it to `circuit` renders nothing.",
        ),
      ])
    }

    // The bridge is not a hole in principle 2: everything eval produces still goes
    // through circuit-json's own schema before it can reach a document.
    const validated = partitionConformant(elements)
    if (!validated.ok) return validated

    return ok({
      ...validated.value,
      diagnostics: collectDiagnostics(validated.value.elements),
      durationMs: Date.now() - started,
    })
  } catch (cause) {
    return err([tsxError(cause, timeoutMs)])
  } finally {
    // Kill on every path: a runner left alive holds the render loop open and the process
    // will not exit.
    await runner.kill().catch(() => undefined)
  }
}

const withTimeout = async <T>(work: Promise<T>, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TsxTimeout(ms)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

class TsxTimeout extends Error {
  constructor(readonly ms: number) {
    super(`Evaluation did not settle within ${ms}ms.`)
    this.name = "TsxTimeout"
  }
}

/**
 * Turn whatever eval threw into an error a model can act on.
 *
 * tscircuit's messages are already specific ("Could not find port .R1 > .pin3"); the
 * value we add is the `hint`, which says what to do about it.
 */
const tsxError = (cause: unknown, timeoutMs: number): ValidationError => {
  if (cause instanceof TsxTimeout) {
    return validationError(
      "TSX_COMPILE_FAILED",
      cause.message,
      `The render did not settle within ${timeoutMs}ms. This usually means an autorouter ` +
        "is working on a board that is too dense — simplify the circuit, or split it " +
        "into subcircuits and add them one at a time.",
    )
  }

  const message = cause instanceof Error ? cause.message : String(cause)

  if (/could not find (port|component)|selector/i.test(message)) {
    return validationError(
      "TSX_COMPILE_FAILED",
      message,
      "A selector in a <trace> does not match anything. Check the component `name` and " +
        'the pin — tscircuit selectors look like ".R1 > .pin1" or ".U1 > .VCC".',
    )
  }

  if (/cannot find module|failed to resolve|import/i.test(message)) {
    return validationError(
      "TSX_COMPILE_FAILED",
      message,
      "Imports are not resolved over the network. Use only tscircuit's built-in " +
        "elements (<board>, <resistor>, <capacitor>, <chip>, <trace>, …) — they need no " +
        "import.",
    )
  }

  return validationError(
    "TSX_COMPILE_FAILED",
    message,
    "The snippet did not evaluate. Fix the reported error and try again; the rest of " +
      "the design is untouched.",
  )
}
