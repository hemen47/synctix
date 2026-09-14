/**
 * Agent contracts.
 *
 * The agent is a loop over core's Operations, not a code generator. Every tool either
 * submits an Operation or reads state; none of them writes files or emits coordinates.
 */

import type { z } from "zod"
import type { Result, ValidationError } from "@syntrix/shared"

/** Roles map to models in config/models.yaml, so swapping a provider is a yaml edit. */
export type AgentRole = "planner" | "executor" | "reviewer" | "embedder"

export interface ModelRouting {
  role: AgentRole
  provider: "openrouter" | "anthropic" | "openai" | "google" | "ollama"
  model: string
  temperature?: number
  maxTokens?: number
}

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string
  description: string
  /** Zod schema, converted to JSON Schema for the provider (zod v3, see ADR-0002). */
  inputSchema: z.ZodType<TInput>
  /**
   * True when the tool changes the design. Mutating tools go through core's `apply`
   * and are recorded in the operation log with the run id.
   */
  mutates: boolean
  /** True when a human must approve before it runs, e.g. create_custom_part. */
  requiresApproval?: boolean
  execute(input: TInput, ctx: ToolContext): Promise<Result<TOutput, ValidationError[]>>
}

export interface ToolContext {
  designId: string
  runId: string
  /** Emit a trace event to the SSE stream. */
  emit(event: AgentTraceEvent): void
}

export type AgentTraceEvent =
  | { kind: "thinking"; text: string; at: string }
  | { kind: "tool_call"; tool: string; input: unknown; callId: string; at: string }
  | { kind: "tool_result"; callId: string; ok: boolean; summary: string; at: string }
  | { kind: "operation_applied"; operationId: string; version: number; at: string }
  | { kind: "erc"; pass: boolean; errorCount: number; warningCount: number; at: string }
  | { kind: "message"; text: string; at: string }
  | { kind: "error"; message: string; at: string }
  | { kind: "done"; iterations: number; tokensIn: number; tokensOut: number; at: string }

export interface AgentRunOptions {
  designId: string
  prompt: string
  mode?: "operations" | "tsx"
  maxIterations?: number
  /** Loop invariant: ERC must run before the agent is allowed to finish. */
  requireErcBeforeFinish?: boolean
}

export interface AgentRunResult {
  runId: string
  iterations: number
  finalVersion: number
  erc?: { pass: boolean; errorCount: number; warningCount: number }
  message: string
  usage: { tokensIn: number; tokensOut: number; costUsd?: number }
  events: AgentTraceEvent[]
}

/** Implemented by the real provider bridge and by MockProvider in tests. */
export interface LlmProvider {
  id: string
  generate(req: {
    role: AgentRole
    system: string
    messages: Array<{ role: "user" | "assistant" | "tool"; content: string }>
    tools: ToolDefinition[]
  }): Promise<{
    text?: string
    toolCalls: Array<{ callId: string; name: string; input: unknown }>
    usage: { tokensIn: number; tokensOut: number }
  }>
}
