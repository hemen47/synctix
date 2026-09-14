/**
 * `PartsIndex` — where curated (T1) parts are searched.
 *
 * Three implementations, one interface:
 *
 * - `LocalPartsIndex` holds parts in memory and ranks them with the same scorer the T0
 *   catalog uses. No database, no network. This is what runs in tests and in a
 *   development stack, and it is why the M2' acceptance criterion can be checked in CI
 *   with nothing running.
 * - `MongoPartsIndex` is the default in a deployed stack: a text index over the fields
 *   an engineer types, plus structured `electrical` fields for range filtering.
 * - `MeiliPartsIndex` is the `search` compose profile — better typo tolerance and
 *   faceting at the cost of another service to run.
 *
 * The ranking rules live in `search.ts` and are shared, so moving between them changes
 * how fast a query is and how large a catalog can be, not which part comes first. An
 * index that invented its own notion of relevance would make "why is this result second"
 * a different question depending on deployment, which is not a question anyone should
 * have to ask twice.
 */

import type { PartDefinition, PartFilters, PartSummary } from "./types"
import { searchParts, toSummary } from "./search"

export interface PartsIndexStatus {
  id: string
  status: "ready" | "disabled"
  /** Why it is unavailable, so a missing service is diagnosable rather than silent. */
  detail?: string
  /** How many parts are indexed, when the index can say cheaply. */
  count?: number
}

export interface PartsIndex {
  readonly id: string
  status(): Promise<PartsIndexStatus>
  search(query: string, filters?: PartFilters): Promise<PartSummary[]>
  get(id: string): Promise<PartDefinition | undefined>
  /** Add or replace parts. Idempotent on `id`, so an ingestion job can be re-run. */
  upsert(parts: PartDefinition[]): Promise<{ upserted: number }>
  remove(ids: string[]): Promise<{ removed: number }>
}

/**
 * The in-memory index.
 *
 * Linear scan over the catalog. That is not a placeholder for something cleverer: T0 is
 * tens of parts and a curated T1 is thousands, and at that size a scan with a good scorer
 * beats a round trip to a search service. `MongoPartsIndex` exists for when T1 stops
 * being thousands.
 */
export class LocalPartsIndex implements PartsIndex {
  readonly id = "local"
  private readonly parts = new Map<string, PartDefinition>()

  constructor(initial: PartDefinition[] = []) {
    for (const part of initial) this.parts.set(part.id, part)
  }

  async status(): Promise<PartsIndexStatus> {
    return { id: this.id, status: "ready", count: this.parts.size }
  }

  async search(query: string, filters?: PartFilters): Promise<PartSummary[]> {
    const scored = searchParts([...this.parts.values()], query, filters)
    return scored.map((s) => toSummary(s.part, this.id))
  }

  async get(id: string): Promise<PartDefinition | undefined> {
    return this.parts.get(id)
  }

  async upsert(parts: PartDefinition[]): Promise<{ upserted: number }> {
    for (const part of parts) this.parts.set(part.id, part)
    return { upserted: parts.length }
  }

  async remove(ids: string[]): Promise<{ removed: number }> {
    let removed = 0
    for (const id of ids) if (this.parts.delete(id)) removed += 1
    return { removed }
  }

  /** Everything indexed, for a caller that wants to re-index elsewhere. */
  all(): PartDefinition[] {
    return [...this.parts.values()]
  }
}

/**
 * Turn our filters into a Mongo query document.
 *
 * Kept as a pure function so it can be tested without a database — which matters, because
 * a filter that silently matches nothing is exactly the kind of bug an integration test
 * skipped in CI would never catch.
 *
 * `$text` is deliberately *not* used for the query string. Mongo's text index stems and
 * drops short tokens, which loses "3.3V" and "SOT-223" — the two most load-bearing terms
 * in a real parts query. Instead the query narrows the candidate set with a regex over
 * the indexed fields and the shared scorer ranks what comes back, so ordering matches the
 * local index exactly.
 */
export const toMongoFilter = (
  query: string,
  filters: PartFilters = {},
): Record<string, unknown> => {
  const and: Record<string, unknown>[] = []

  const terms = query
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1)

  if (terms.length > 0) {
    // Every term must appear somewhere in the part; which field is not important, and
    // requiring a specific one is how a search stops finding things.
    for (const term of terms) {
      const rx = { $regex: escapeRegex(term), $options: "i" }
      and.push({
        $or: [
          { mpn: rx },
          { description: rx },
          { category: rx },
          { package: rx },
          { manufacturer: rx },
          { aliases: rx },
        ],
      })
    }
  }

  if (filters.category) and.push({ category: filters.category })
  if (filters.package) and.push({ package: filters.package })
  if (filters.manufacturer) and.push({ manufacturer: filters.manufacturer })

  for (const [name, range] of Object.entries(filters.params ?? {})) {
    const path = `electrical.${name}`
    if (range.eq !== undefined) {
      and.push({ [path]: range.eq })
      continue
    }
    const bounds: Record<string, number> = {}
    if (range.min !== undefined) bounds["$gte"] = range.min
    if (range.max !== undefined) bounds["$lte"] = range.max
    if (Object.keys(bounds).length > 0) and.push({ [path]: bounds })
  }

  return and.length > 0 ? { $and: and } : {}
}

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** The index definitions a Mongo-backed store needs. Applied at startup, idempotently. */
export const MONGO_PART_INDEXES = [
  { key: { id: 1 }, unique: true },
  { key: { mpn: 1 } },
  { key: { category: 1, package: 1 } },
  // The text index is not what `toMongoFilter` searches, but it is what makes an
  // operator's ad-hoc `$text` query from a shell usable, and it costs one index.
  { key: { mpn: "text", description: "text", category: "text", package: "text" } },
] as const

/**
 * A minimal view of the Mongo collection API.
 *
 * Declared here rather than importing mongodb's types so that `@syntrix/parts` does not
 * take a driver dependency for a class most deployments instantiate once. The api passes
 * in a real collection; a test passes in a fake.
 */
export interface PartsCollectionLike {
  find(
    filter: Record<string, unknown>,
    options?: { limit?: number },
  ): { toArray(): Promise<unknown[]> }
  findOne(filter: Record<string, unknown>): Promise<unknown>
  bulkWrite(operations: unknown[]): Promise<unknown>
  deleteMany(filter: Record<string, unknown>): Promise<{ deletedCount?: number }>
  countDocuments(): Promise<number>
  createIndexes?(indexes: unknown[]): Promise<unknown>
}

/**
 * The Mongo-backed T1 store.
 *
 * Narrowing happens in the database and ranking happens here, with the shared scorer —
 * see `toMongoFilter` for why the query is a regex rather than `$text`. The candidate
 * limit exists because ranking cannot happen in Mongo without duplicating the scorer in
 * aggregation stages, and a scorer that exists twice will disagree with itself.
 */
export class MongoPartsIndex implements PartsIndex {
  readonly id = "mongo"

  constructor(
    private readonly collection: PartsCollectionLike,
    private readonly options: { candidateLimit?: number } = {},
  ) {}

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndexes?.([...MONGO_PART_INDEXES])
  }

  async status(): Promise<PartsIndexStatus> {
    try {
      return { id: this.id, status: "ready", count: await this.collection.countDocuments() }
    } catch (cause) {
      return {
        id: this.id,
        status: "disabled",
        detail: cause instanceof Error ? cause.message : "unreachable",
      }
    }
  }

  async search(query: string, filters?: PartFilters): Promise<PartSummary[]> {
    const candidates = (await this.collection
      .find(toMongoFilter(query, filters), {
        limit: this.options.candidateLimit ?? 500,
      })
      .toArray()) as PartDefinition[]

    return searchParts(candidates, query, filters).map((s) => toSummary(s.part, this.id))
  }

  async get(id: string): Promise<PartDefinition | undefined> {
    const found = (await this.collection.findOne({ id })) as PartDefinition | null
    return found ?? undefined
  }

  async upsert(parts: PartDefinition[]): Promise<{ upserted: number }> {
    if (parts.length === 0) return { upserted: 0 }
    await this.collection.bulkWrite(
      parts.map((part) => ({
        replaceOne: { filter: { id: part.id }, replacement: part, upsert: true },
      })),
    )
    return { upserted: parts.length }
  }

  async remove(ids: string[]): Promise<{ removed: number }> {
    const result = await this.collection.deleteMany({ id: { $in: ids } })
    return { removed: result.deletedCount ?? 0 }
  }
}

/**
 * Pick an index from configuration.
 *
 * A stack with no `MONGO_URL` gets the local index and works — that is the point of
 * having three implementations rather than a hard dependency on a database. Falling back
 * is announced through `status()`, never silently.
 */
export const selectPartsIndex = (options: {
  mongoCollection?: PartsCollectionLike
  fallbackParts?: PartDefinition[]
}): PartsIndex =>
  options.mongoCollection
    ? new MongoPartsIndex(options.mongoCollection)
    : new LocalPartsIndex(options.fallbackParts ?? [])
