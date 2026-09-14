/**
 * The TSX bridge — how TSX mode lands.
 *
 * The LLM writes a tscircuit `<board>` against the official tscircuit skill; this module
 * evaluates it and hands the result to `merge_circuit_json`, the one validated door into
 * the document. TSX is an **input** format, never a stored one: the document is always
 * circuit-json (principle 3).
 *
 * **This module is not in `@syntrix/core`'s main entry point.** Import it from
 * `@syntrix/core/tsx`, which the api does and the browser does not. Importing
 * `@tscircuit/eval` — even for its types alone — pulls in the entire tscircuit render
 * stack, including packages that ship TypeScript source rather than declarations, so a
 * browser build that touched it would compile other people's solvers to render a
 * schematic it will never evaluate.
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
import {
  collectDiagnostics,
  partitionConformant,
  type SpecSkew,
  type TsxDiagnostic,
} from "./tsx-conformance"

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

/** The part of `CircuitRunner` we actually use, verified against @tscircuit/eval 0.0.1402. */
interface Runner {
  setDisableCdnLoading(disable: boolean): Promise<void>
  execute(code: string, opts?: { name?: string }): Promise<void>
  renderUntilSettled(): Promise<void>
  getCircuitJson(): Promise<AnyCircuitElement[]>
  kill(): Promise<void>
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

  // Imported lazily, and typed locally rather than from the package.
  //
  // Two reasons. Lazily, because @tscircuit/eval pulls in the whole tscircuit render
  // stack and a process that never compiles TSX should not pay for it. Locally typed,
  // because following eval's types reaches TypeScript *source* inside its dependency
  // tree, which drags unrelated compile errors from other people's packages into every
  // consumer of @syntrix/core — including the browser bundle, which never runs this.
  // The five methods below are the whole surface we use; a change to any of them is a
  // runtime failure the tests catch immediately.
  const { CircuitRunner } = (await import("@tscircuit/eval")) as unknown as {
    CircuitRunner: new (config: { snippetsApiBaseUrl: string; cjsRegistryUrl: string }) => Runner
  }
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
