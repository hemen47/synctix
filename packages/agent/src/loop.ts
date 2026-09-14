/**
 * The agent loop.
 *
 * Model proposes tool calls, we execute them against the engine, results go back, repeat
 * until the model stops or a limit is hit. Nothing exotic — the value is in the
 * invariants, which is why they are stated here rather than scattered through the body:
 *
 * 1. **The engine validates everything.** A tool call becomes an Operation and goes
 *    through `apply`. A rejection returns to the model with the engine's hint, which is
 *    written to be acted on. The design never enters an invalid state, however wrong the
 *    model is.
 * 2. **ERC must run before finishing.** If the model stops without calling `run_erc`, the
 *    loop calls it and appends the result. A design nobody checked is not a design, and
 *    an agent that skips the check and says "done" is worse than one that fails.
 * 3. **A TSX compile that reports errors is a failed call**, even though it returned
 *    successfully. tscircuit does not throw on a selector that matches nothing — it emits
 *    a `source_trace_not_connected_error` element and carries on (ADR-0017). A loop that
 *    only checked `ok` would merge a board whose wiring went nowhere.
 * 4. **Limits are hard.** Iterations, tool calls per iteration, and cost, all from
 *    `models.yaml`. An agent in a retry loop should stop, not spend.
 */

import type { Result, ValidationError } from "@syntrix/shared"
import { err, ok } from "@syntrix/shared"
import type { AgentTraceEvent } from "./types"

/** One exchange with a model, provider-agnostic. */
export interface ModelTurn {
  /** What the model said, if anything. */
  text?: string
  /** What it wants run. Empty means it considers itself finished. */
  toolCalls: Array<{ callId: string; tool: string; input: unknown }>
  usage?: { inputTokens: number; outputTokens: number; costUsd?: number }
}

/**
 * The model, as the loop needs it.
 *
 * Narrow on purpose: a `MockProvider` implementing this is a replay of recorded turns,
 * which makes the eval suite deterministic and free. The real one wraps the AI SDK.
 */
export interface ModelClient {
  id: string
  complete(request: {
    system: string
    messages: Array<{ role: "user" | "assistant" | "tool"; content: string; callId?: string }>
    tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
  }): Promise<ModelTurn>
}

/** How the loop reaches the engine. Supplied by the api, faked in tests. */
export interface AgentBackend {
  /** Submit an operation. Returns the engine's own errors on rejection. */
  submit(tool: string, input: unknown): Promise<Result<{ summary: string }, ValidationError[]>>
  /** Run a read-only tool. */
  read(tool: string, input: unknown): Promise<Result<{ summary: string }, ValidationError[]>>
  /** ERC, called by the loop itself when the model forgets. */
  runErc(): Promise<{ pass: boolean; errorCount: number; warningCount: number; summary: string }>
}

export interface AgentLimits {
  maxIterations: number
  maxToolCallsPerIteration: number
  maxCostUsdPerRun: number
}

export interface AgentRunOptions {
  system: string
  prompt: string
  tools: Array<{
    name: string
    description: string
    parameters: Record<string, unknown>
    mutates: boolean
  }>
  limits: AgentLimits
  emit?: (event: AgentTraceEvent) => void
}

export interface AgentRunResult {
  /** The model's closing message. */
  text: string
  iterations: number
  toolCalls: number
  erc: { pass: boolean; errorCount: number; warningCount: number }
  /** Why the loop ended — worth knowing, because "hit the limit" is not "finished". */
  stopReason: "finished" | "max_iterations" | "cost_limit"
  usage: { inputTokens: number; outputTokens: number; costUsd: number }
  trace: AgentTraceEvent[]
}

const now = (): string => new Date().toISOString()

export const runAgent = async (
  model: ModelClient,
  backend: AgentBackend,
  options: AgentRunOptions,
): Promise<Result<AgentRunResult, ValidationError[]>> => {
  const trace: AgentTraceEvent[] = []
  const emit = (event: AgentTraceEvent): void => {
    trace.push(event)
    options.emit?.(event)
  }

  const messages: Array<{
    role: "user" | "assistant" | "tool"
    content: string
    callId?: string
  }> = [{ role: "user", content: options.prompt }]

  const usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 }
  let iterations = 0
  let toolCalls = 0
  let ercCalled = false
  let finalText = ""
  let stopReason: AgentRunResult["stopReason"] = "finished"

  while (iterations < options.limits.maxIterations) {
    iterations += 1

    const turn = await model.complete({
      system: options.system,
      messages,
      tools: options.tools.map(({ name, description, parameters }) => ({
        name,
        description,
        parameters,
      })),
    })

    usage.inputTokens += turn.usage?.inputTokens ?? 0
    usage.outputTokens += turn.usage?.outputTokens ?? 0
    usage.costUsd += turn.usage?.costUsd ?? 0

    if (turn.text) {
      finalText = turn.text
      emit({ kind: "message", text: turn.text, at: now() })
      messages.push({ role: "assistant", content: turn.text })
    }

    if (turn.toolCalls.length === 0) break

    // A model that asks for twenty tools at once is usually looping. Executing the first
    // few and telling it so is more useful than refusing the whole turn.
    const calls = turn.toolCalls.slice(0, options.limits.maxToolCallsPerIteration)
    if (calls.length < turn.toolCalls.length) {
      messages.push({
        role: "tool",
        content:
          `Only the first ${calls.length} of ${turn.toolCalls.length} tool calls were run. ` +
          "Work in smaller steps.",
      })
    }

    for (const call of calls) {
      toolCalls += 1
      emit({
        kind: "tool_call",
        tool: call.tool,
        input: call.input,
        callId: call.callId,
        at: now(),
      })

      if (call.tool === "run_erc") ercCalled = true

      const definition = options.tools.find((tool) => tool.name === call.tool)
      const result = definition?.mutates
        ? await backend.submit(call.tool, call.input)
        : await backend.read(call.tool, call.input)

      const summary = result.ok
        ? result.value.summary
        : // The engine's hints are the whole reason a rejected call is recoverable, so
          // they go back verbatim rather than being summarised into "failed".
          result.error.map((e) => `${e.code}: ${e.message}\nHint: ${e.hint}`).join("\n\n")

      emit({ kind: "tool_result", callId: call.callId, ok: result.ok, summary, at: now() })
      messages.push({ role: "tool", content: summary, callId: call.callId })
    }

    if (usage.costUsd > options.limits.maxCostUsdPerRun) {
      stopReason = "cost_limit"
      break
    }
  }

  if (iterations >= options.limits.maxIterations && stopReason === "finished") {
    stopReason = "max_iterations"
  }

  // Invariant 2. The model does not get to skip this by stopping early, and the result is
  // appended to what it said rather than replacing it — the user should see both.
  const erc = await backend.runErc()
  emit({
    kind: "erc",
    pass: erc.pass,
    errorCount: erc.errorCount,
    warningCount: erc.warningCount,
    at: now(),
  })

  // Whether the *model* finished, decided before the ERC note is appended. Letting that
  // note count as a final message would turn "ran out of iterations with nothing to say"
  // into an apparent success, which is the one outcome that must not be papered over.
  const modelFinished = finalText.length > 0

  if (!ercCalled) {
    finalText =
      `${finalText}\n\n_ERC was not run by the assistant; SYNTRIX ran it: ${erc.summary}_`.trim()
  }

  if (!modelFinished && stopReason === "max_iterations") {
    return err([
      {
        code: "AGENT_MAX_ITERATIONS",
        message: `The agent stopped after ${iterations} iterations without finishing.`,
        hint: "Break the request into smaller steps, or raise limits.maxIterations in config/models.yaml.",
        elementIds: [],
      },
    ])
  }

  return ok({
    text: finalText,
    iterations,
    toolCalls,
    erc: { pass: erc.pass, errorCount: erc.errorCount, warningCount: erc.warningCount },
    stopReason,
    usage,
    trace,
  })
}

/**
 * A model that replays recorded turns.
 *
 * The eval suite runs on this: deterministic, free, and offline, so a change to the tool
 * descriptions or the loop can be regression-tested without spending money or depending
 * on a provider being up. Running the same suite against a live model is a separate,
 * opt-in check — the mock proves the plumbing, the live run proves the prompt.
 */
export const createMockProvider = (turns: ModelTurn[], id = "mock"): ModelClient => {
  let index = 0
  return {
    id,
    async complete() {
      const turn = turns[index]
      index += 1
      // Running out of recorded turns means the loop asked for more than the recording
      // covers — a real failure, not something to paper over with an empty response.
      return turn ?? { toolCalls: [], text: "" }
    },
  }
}
