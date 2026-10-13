/**
 * The real `ModelClient`: the loop's narrow interface, over the Vercel AI SDK.
 *
 * `models.ts` builds a provider's `LanguageModel`; `loop.ts` wants something that takes a
 * system prompt, a flat message list and a tool list, and returns one turn. This module
 * is the join, and it is the only place in the agent that imports `ai`.
 *
 * **The awkward part is message shape.** The loop keeps a flat transcript — a user
 * message, assistant text, tool results tagged with a `callId` — and never records the
 * assistant's *tool calls*, because it does not need them: it has just executed them.
 * Every provider does need them. Anthropic and OpenAI both reject a `tool_result` that is
 * not preceded by an assistant message containing the matching `tool_use`, and the error
 * they give for it is not obviously about message shape.
 *
 * So the bridge remembers the tool calls it hands back (`emitted`) and re-inserts them on
 * the way in. That keeps `loop.ts` provider-agnostic and untouched — it is covered by the
 * eval suite against `createMockProvider`, and a change there to satisfy one SDK's message
 * format would be a change to the tested core for the benefit of the untested edge.
 */

import type { ModelMessage } from "ai"
import type { ModelClient, ModelTurn } from "./loop"
import { createModel, resolveRouting, type ModelsConfig } from "./models"
import type { AgentRole } from "./types"

/** What the loop hands `complete`, named so the conversion below reads. */
type LoopMessage = { role: "user" | "assistant" | "tool"; content: string; callId?: string }

/** A tool call this bridge has already returned, kept so it can be replayed inbound. */
interface EmittedCall {
  toolName: string
  input: unknown
}

export interface ModelClientOptions {
  /** Abandon a single completion after this long. Defaults to 120s. */
  timeoutMs?: number
  /** Retries inside the SDK for a transient provider failure. */
  maxRetries?: number
}

/**
 * Build a `ModelClient` for a role.
 *
 * Resolution (env override, then yaml, then defaults) and the availability check both
 * happen in `models.ts`, so a missing key fails here — before a run starts — rather than
 * four tool calls in.
 */
export const createModelClient = async (
  config: ModelsConfig,
  role: AgentRole,
  env: NodeJS.ProcessEnv = process.env,
  options: ModelClientOptions = {},
): Promise<ModelClient> => {
  const routing = resolveRouting(config, role, env)
  const model = await createModel(config, routing, env)

  // Imported here rather than at module load. `ai` pulls in the whole provider-utils
  // stack, and an api process that serves the editor without ever running the agent
  // should not pay for it — the same reason `@syntrix/core/tsx` is loaded on demand.
  const { generateText, jsonSchema } = await import("ai")

  // Populated as turns are returned, read when the next turn's messages come back in.
  const emitted = new Map<string, EmittedCall>()

  return {
    id: `${routing.provider}:${routing.model}`,

    async complete(request) {
      const result = await generateText({
        model: model as Parameters<typeof generateText>[0]["model"],
        system: request.system,
        messages: toModelMessages(request.messages as LoopMessage[], emitted),
        tools: Object.fromEntries(
          request.tools.map((tool) => [
            tool.name,
            {
              description: tool.description,
              // The schemas are already JSON Schema, derived from core's Zod definitions
              // in `tools.ts`. `jsonSchema()` hands them to the provider as-is rather than
              // round-tripping them through Zod a second time.
              inputSchema: jsonSchema(tool.parameters as Parameters<typeof jsonSchema>[0]),
            },
          ]),
        ),
        temperature: routing.temperature ?? 0.2,
        maxOutputTokens: routing.maxTokens ?? 4096,
        maxRetries: options.maxRetries ?? 2,
        timeout: options.timeoutMs ?? 120_000,
        // One provider round trip per loop iteration. The SDK can run its own tool loop,
        // but then the engine's validation, the ERC invariant and the cost ceiling would
        // all sit outside it — the loop's four invariants are the product.
        stopWhen: () => true,
      })

      const toolCalls = result.toolCalls.map((call) => {
        emitted.set(call.toolCallId, { toolName: call.toolName, input: call.input })
        return { callId: call.toolCallId, tool: call.toolName, input: call.input }
      })

      const turn: ModelTurn = {
        toolCalls,
        usage: {
          inputTokens: result.usage.inputTokens ?? 0,
          outputTokens: result.usage.outputTokens ?? 0,
          // Deliberately absent. The SDK reports tokens, not money, and a price table
          // hardcoded here would be wrong the week a provider changes it — a cost ceiling
          // enforced against invented numbers is worse than one that does not bind.
          // `maxIterations` is the limit that actually holds a run down.
        },
      }

      if (result.text.length > 0) turn.text = result.text
      return turn
    },
  }
}

/**
 * The loop's flat transcript as provider messages.
 *
 * Tool results arrive in runs — the loop executes every call in an iteration before going
 * back to the model — so each run is emitted as one assistant message carrying the calls,
 * then one tool message carrying the results. That is the shape both Anthropic and OpenAI
 * expect, and batching matches how the calls were actually made.
 *
 * A tool message with no `callId` is the loop talking, not a provider result: the
 * "only the first N calls were run" note. It becomes a user message, because there is no
 * call for it to be a result of.
 */
export const toModelMessages = (
  messages: LoopMessage[],
  emitted: Map<string, EmittedCall>,
): ModelMessage[] => {
  const out: ModelMessage[] = []
  let pending: LoopMessage[] = []

  const flush = (): void => {
    if (pending.length === 0) return

    const known = pending.filter((message) => emitted.has(message.callId!))

    if (known.length > 0) {
      out.push({
        role: "assistant",
        content: known.map((message) => {
          const call = emitted.get(message.callId!)!
          return {
            type: "tool-call" as const,
            toolCallId: message.callId!,
            toolName: call.toolName,
            input: call.input,
          }
        }),
      })

      out.push({
        role: "tool",
        content: known.map((message) => {
          const call = emitted.get(message.callId!)!
          return {
            type: "tool-result" as const,
            toolCallId: message.callId!,
            toolName: call.toolName,
            output: { type: "text" as const, value: message.content },
          }
        }),
      })
    }

    // A result whose call this bridge never emitted cannot be paired with a `tool_use`,
    // and sending it unpaired is the one thing providers reject outright. It still carries
    // information the model needs, so it goes in as narration rather than being dropped.
    for (const orphan of pending.filter((message) => !emitted.has(message.callId!))) {
      out.push({ role: "user", content: `[tool result] ${orphan.content}` })
    }

    pending = []
  }

  for (const message of messages) {
    if (message.role === "tool" && message.callId) {
      pending.push(message)
      continue
    }

    flush()

    out.push(
      message.role === "tool"
        ? { role: "user", content: message.content }
        : { role: message.role, content: message.content },
    )
  }

  flush()
  return out
}
