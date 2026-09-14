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
}
