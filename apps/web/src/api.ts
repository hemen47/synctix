/**
 * The API client.
 *
 * Thin on purpose: the browser holds no domain logic (principle 2). Everything here is a
 * fetch plus error translation — the server's problem+json comes back as a typed error
 * carrying the engine's own `hint`, because that is the text the UI should show a user
 * whose edit was rejected. "Operation failed" helps nobody; "pin 3 of U1 is already
 * connected to VCC" does.
 */

import type { AnyCircuitElement } from "circuit-json"

const BASE = "/api"

export interface DesignResponse {
  id: string
  name: string
  version: number
  logLength: number
  createdAt: string
  updatedAt: string
  circuit: AnyCircuitElement[]
  meta: Record<string, unknown>
  manualEdits: {
    schematic_placements?: Array<{
      selector: string
      relative_to: string
      center: { x: number; y: number }
    }>
    pcb_placements?: Array<{
      selector: string
      relative_to: string
      center: { x: number; y: number }
    }>
  }
}

export interface DesignSummary {
  id: string
  name: string
  version: number
  updatedAt: string
}

export interface PartHit {
  id: string
  mpn?: string
  manufacturer?: string
  description: string
  category: string
  package?: string
  footprintVerified: boolean
  source: string
}

export interface ErcReport {
  violations: Array<{
    rule: string
    severity: "error" | "warning"
    message: string
    hint?: string
    elementIds?: string[]
  }>
  errorCount?: number
  warningCount?: number
}

/** A rejected request, with the engine's hint intact. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly hint?: string,
    readonly code?: string,
  ) {
    super(message)
    this.name = "ApiError"
  }
}

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  })

  if (!response.ok) {
    const problem = (await response.json().catch(() => undefined)) as
      | {
          title?: string
          detail?: string
          errors?: Array<{ message: string; hint?: string; code?: string }>
        }
      | undefined
    const first = problem?.errors?.[0]
    throw new ApiError(
      response.status,
      first?.message ?? problem?.detail ?? problem?.title ?? response.statusText,
      first?.hint,
      first?.code,
    )
  }

  return response.status === 204 ? (undefined as T) : ((await response.json()) as T)
}

export const api = {
  listDesigns: () => request<{ designs: DesignSummary[] }>("/designs"),

  createDesign: (name: string) =>
    request<DesignSummary>("/designs", { method: "POST", body: JSON.stringify({ name }) }),

  getDesign: (id: string) => request<DesignResponse>(`/designs/${id}`),

  /**
   * Submit one operation.
   *
   * `expectedVersion` is always sent. A client that omits it is asking to overwrite
   * whatever it has not seen, and the whole point of the log is that it does not have to.
   */
  submit: (id: string, operation: unknown, expectedVersion: number) =>
    request<DesignResponse>(`/designs/${id}/operations`, {
      method: "POST",
      body: JSON.stringify({ operation, expectedVersion }),
    }),

  undo: (id: string) => request<DesignResponse>(`/designs/${id}/undo`, { method: "POST" }),
  redo: (id: string) => request<DesignResponse>(`/designs/${id}/redo`, { method: "POST" }),

  layout: (id: string) =>
    request<{
      elements: AnyCircuitElement[]
      bounds: { minX: number; minY: number; maxX: number; maxY: number }
    }>(`/designs/${id}/layout`, { method: "POST" }),

  erc: (id: string) => request<ErcReport>(`/designs/${id}/erc`),

  searchParts: (query: string) =>
    request<{ results: PartHit[]; index: string }>(
      `/parts/search?q=${encodeURIComponent(query)}&limit=30`,
    ),

  agentStatus: () => request<AgentStatus>("/agent/status"),

  partsCapabilities: () =>
    request<{ canAddParts: boolean; index: string; prefix: string }>("/parts/capabilities"),

  createPart: (part: UserPartInput) =>
    request<{ id: string }>("/parts", { method: "POST", body: JSON.stringify(part) }),

  deletePart: (id: string) =>
    request<void>(`/parts/${encodeURIComponent(id)}`, { method: "DELETE" }),

  route: (id: string) =>
    request<{ traceCount: number; padCount: number; routingFailed: boolean }>(
      `/designs/${id}/route`,
      { method: "POST", body: JSON.stringify({}) },
    ),

  exportDesign: (id: string, format: string) =>
    request<{ format: string; artifacts: ExportArtifact[] }>(`/designs/${id}/export/${format}`, {
      method: "POST",
      body: JSON.stringify({}),
    }),

  /**
   * The URL of a rendered view, not its contents.
   *
   * A URL rather than a fetch because these go straight into `<img src>` — the browser
   * handles loading, caching and cancellation better than we would, and a 2MB PCB SVG
   * never passes through JavaScript. `v` busts the cache on every version so the pane
   * cannot show a stale board.
   */
  renderUrl: (id: string, view: ViewName, version: number) =>
    `${BASE}/designs/${id}/render/${view}?v=${version}`,
}

export type ViewName = "schematic" | "pcb" | "assembly" | "pinout"

/** The pin roles the engine knows. ERC uses them, so they are not decoration. */
export const PIN_KINDS = [
  "passive",
  "input",
  "output",
  "bidirectional",
  "power_in",
  "power_out",
  "ground",
  "open_drain",
  "open_collector",
  "tristate",
  "no_connect",
  "unspecified",
] as const

export type PinKind = (typeof PIN_KINDS)[number]

/** What the part form collects. Everything else is filled in server-side. */
export interface UserPartInput {
  name: string
  description?: string
  category?: string
  ftype?: string
  footprinterString?: string
  datasheetUrl?: string
  pins: Array<{ number: number | string; name: string; kind?: PinKind }>
}

export interface ExportArtifact {
  filename: string
  mime: string
  text?: string
  bytes?: string
}

export interface AgentStatus {
  available: boolean
  detail?: string
  roles: Array<{
    role: "planner" | "executor" | "reviewer"
    provider?: string
    model?: string
    available: boolean
    detail?: string
  }>
  limits?: { maxIterations: number; maxToolCallsPerIteration: number; maxCostUsdPerRun: number }
}

/** What the loop emits, mirrored from `AgentTraceEvent` in `@syntrix/agent`. */
export type TraceEvent =
  | { kind: "thinking"; text: string; at: string }
  | { kind: "tool_call"; tool: string; input: unknown; callId: string; at: string }
  | { kind: "tool_result"; callId: string; ok: boolean; summary: string; at: string }
  | { kind: "operation_applied"; operationId: string; version: number; at: string }
  | { kind: "erc"; pass: boolean; errorCount: number; warningCount: number; at: string }
  | { kind: "message"; text: string; at: string }
  | { kind: "error"; message: string; at: string }
  | { kind: "done"; iterations: number; tokensIn: number; tokensOut: number; at: string }

export interface AgentDone {
  runId: string
  text: string
  iterations: number
  toolCalls: number
  erc: { pass: boolean; errorCount: number; warningCount: number }
  stopReason: "finished" | "max_iterations" | "cost_limit"
  usage: { inputTokens: number; outputTokens: number; costUsd: number }
}

export interface AgentHandlers {
  onStart?(info: { runId: string; model: string }): void
  onTrace?(event: TraceEvent): void
  onDone?(done: AgentDone): void
  onError?(message: string, hint?: string): void
}

/**
 * Run the agent, streaming its trace.
 *
 * `fetch` with a reader rather than `EventSource`, for two reasons that both matter here:
 * `EventSource` cannot issue a POST, so the prompt would have to go in a query string; and
 * it reconnects automatically on close, which for a one-shot run means silently starting a
 * second one. A reader ends when the stream ends.
 *
 * Returns an abort function. A run the user cancelled must actually stop — the server
 * watches for the socket closing and abandons the loop.
 */
export const runAgent = (
  designId: string,
  prompt: string,
  handlers: AgentHandlers,
): (() => void) => {
  const controller = new AbortController()

  void (async () => {
    try {
      const response = await fetch(`${BASE}/designs/${designId}/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
        signal: controller.signal,
      })

      if (!response.ok || !response.body) {
        // The pre-stream failures — no key, no design, empty prompt — all land here as
        // problem+json, which is the whole reason they are not sent inside the stream.
        const problem = (await response.json().catch(() => undefined)) as
          { detail?: string; errors?: Array<{ message: string; hint?: string }> } | undefined
        const first = problem?.errors?.[0]
        handlers.onError?.(
          first?.message ?? problem?.detail ?? `The agent could not start (${response.status}).`,
          first?.hint,
        )
        return
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""

      for (;;) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })

        // SSE frames are separated by a blank line. A chunk can split one anywhere, so
        // the tail stays in the buffer until its terminator arrives.
        const frames = buffer.split("\n\n")
        buffer = frames.pop() ?? ""

        for (const frame of frames) {
          const event = /^event: (.+)$/m.exec(frame)?.[1]
          const raw = frame
            .split("\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => line.slice(6))
            .join("\n")
          if (!event || raw.length === 0) continue

          const data = JSON.parse(raw) as Record<string, unknown>

          if (event === "start") {
            handlers.onStart?.(data as unknown as { runId: string; model: string })
          } else if (event === "trace") {
            handlers.onTrace?.(data as unknown as TraceEvent)
          } else if (event === "done") {
            handlers.onDone?.(data as unknown as AgentDone)
          } else if (event === "error") {
            const errors = data["errors"] as Array<{ message: string; hint?: string }> | undefined
            handlers.onError?.(errors?.[0]?.message ?? "The run failed.", errors?.[0]?.hint)
          }
        }
      }
    } catch (error) {
      // An abort is the user's own doing, not a failure to report.
      if (controller.signal.aborted) return
      handlers.onError?.(error instanceof Error ? error.message : "The agent stream failed.")
    }
  })()

  return () => controller.abort()
}
