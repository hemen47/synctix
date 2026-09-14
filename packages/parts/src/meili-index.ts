/**
 * The Meilisearch adapter — the `search` compose profile, and nothing else.
 *
 * It exists for one reason: typo tolerance. "ams1117" and "ams 1117" and "AMS1117-3.3"
 * all find the part under `LocalPartsIndex`, because the scorer knows about packages and
 * synonyms, but "amd1117" does not, and a person who mistypes an MPN is not having an
 * unusual day. That is what Meilisearch buys, and it is not worth a required service.
 *
 * Talking to it over HTTP rather than through the `meilisearch` client package keeps
 * `@syntrix/parts` free of a dependency that only one deployment shape uses. The three
 * endpoints needed are stable and documented, and `fetch` is in the runtime.
 */

import type { PartDefinition, PartFilters, PartSummary } from "./types"
import type { PartsIndex, PartsIndexStatus } from "./parts-index"
import { toSummary } from "./search"

export interface MeiliOptions {
  url?: string
  apiKey?: string
  indexName?: string
  /** Bound every request, so an unreachable service degrades rather than hangs. */
  timeoutMs?: number
}

const DEFAULT_INDEX = "parts"
const DEFAULT_TIMEOUT_MS = 5_000

export class MeiliPartsIndex implements PartsIndex {
  readonly id = "meilisearch"

  private readonly url?: string
  private readonly apiKey?: string
  private readonly indexName: string
  private readonly timeoutMs: number

  constructor(options: MeiliOptions = {}) {
    this.url = options.url?.replace(/\/+$/, "")
    this.apiKey = options.apiKey
    this.indexName = options.indexName ?? DEFAULT_INDEX
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /**
   * Configured or not.
   *
   * No URL means the `search` profile is not running, which is the normal case and not a
   * fault — the same rule every optional parts source follows.
   */
  private get configured(): boolean {
    return Boolean(this.url)
  }

  async status(): Promise<PartsIndexStatus> {
    if (!this.configured) {
      return { id: this.id, status: "disabled", detail: "MEILI_URL is not set" }
    }
    try {
      const health = await this.request("GET", "/health")
      return health
        ? { id: this.id, status: "ready" }
        : { id: this.id, status: "disabled", detail: "health check failed" }
    } catch (cause) {
      return {
        id: this.id,
        status: "disabled",
        detail: cause instanceof Error ? cause.message : "unreachable",
      }
    }
  }

  async search(query: string, filters?: PartFilters): Promise<PartSummary[]> {
    if (!this.configured) return []

    const body: Record<string, unknown> = {
      q: query,
      limit: filters?.limit ?? 25,
    }
    const filter = toMeiliFilter(filters)
    if (filter.length > 0) body["filter"] = filter

    const response = (await this.request("POST", `/indexes/${this.indexName}/search`, body)) as
      { hits?: PartDefinition[] } | undefined

    // Meilisearch has already ranked these. Re-scoring them locally would throw away the
    // typo tolerance that is the entire reason for running it.
    return (response?.hits ?? []).map((part) => toSummary(part, this.id))
  }

  async get(id: string): Promise<PartDefinition | undefined> {
    if (!this.configured) return undefined
    const document = (await this.request(
      "GET",
      `/indexes/${this.indexName}/documents/${encodeURIComponent(id)}`,
    )) as PartDefinition | undefined
    return document ?? undefined
  }

  async upsert(parts: PartDefinition[]): Promise<{ upserted: number }> {
    if (!this.configured || parts.length === 0) return { upserted: 0 }
    await this.request("POST", `/indexes/${this.indexName}/documents?primaryKey=id`, parts)
    return { upserted: parts.length }
  }

  async remove(ids: string[]): Promise<{ removed: number }> {
    if (!this.configured || ids.length === 0) return { removed: 0 }
    await this.request("POST", `/indexes/${this.indexName}/documents/delete-batch`, ids)
    return { removed: ids.length }
  }

  /**
   * Which fields can be filtered and which are searchable.
   *
   * Meilisearch refuses a filter on an undeclared attribute, so this has to run once
   * before the first filtered search. Applying it is idempotent.
   */
  async configureIndex(): Promise<void> {
    if (!this.configured) return
    await this.request("PATCH", `/indexes/${this.indexName}/settings`, {
      searchableAttributes: [
        "mpn",
        "description",
        "category",
        "package",
        "manufacturer",
        "aliases",
      ],
      filterableAttributes: ["category", "package", "manufacturer", "footprintVerified"],
      sortableAttributes: ["mpn"],
    })
  }

  private async request(
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await fetch(`${this.url}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
      if (!response.ok) return undefined
      return await response.json()
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * Our filters as Meilisearch filter expressions.
 *
 * Only the attributes declared filterable in `configureIndex` appear here. Parameter
 * ranges are deliberately left out: they live under `electrical.*`, which would mean
 * declaring every electrical parameter filterable up front, and the set of parameters is
 * open. A caller that needs a range filter uses the Mongo or local index, which can do it
 * without knowing the parameter names in advance.
 */
export const toMeiliFilter = (filters?: PartFilters): string[] => {
  if (!filters) return []
  const clauses: string[] = []
  if (filters.category) clauses.push(`category = ${quote(filters.category)}`)
  if (filters.package) clauses.push(`package = ${quote(filters.package)}`)
  if (filters.manufacturer) clauses.push(`manufacturer = ${quote(filters.manufacturer)}`)
  return clauses
}

const quote = (value: string): string => `"${value.replace(/"/g, '\\"')}"`
