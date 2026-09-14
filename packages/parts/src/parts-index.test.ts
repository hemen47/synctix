/**
 * The T1 index layer.
 *
 * The M2' exit criterion is checked here, against the local index, so it passes with no
 * database and no search service running — which is the point of having three
 * implementations behind one interface.
 *
 * The Mongo implementation is covered by testing the query it builds and by driving it
 * through a fake collection. A test that needed a live mongod would be skipped in CI, and
 * a skipped test is not a test.
 */

import { describe, expect, it } from "vitest"
import { T0_PARTS } from "./t0-catalog"
import {
  LocalPartsIndex,
  MongoPartsIndex,
  selectPartsIndex,
  toMongoFilter,
  type PartsCollectionLike,
} from "./parts-index"
import { MeiliPartsIndex, toMeiliFilter } from "./meili-index"
import type { PartDefinition } from "./types"

describe("LocalPartsIndex", () => {
  const index = () => new LocalPartsIndex(T0_PARTS)

  it('satisfies the M2 criterion: "3.3V LDO SOT-223" finds a verified AMS1117', async () => {
    const results = await index().search("3.3V LDO SOT-223")

    const ams1117 = results.find((r) => (r.mpn ?? "").toUpperCase().startsWith("AMS1117"))
    expect(ams1117).toBeDefined()
    // A footprint nobody checked is a board that does not fit its parts, which is the
    // most expensive failure mode in this domain.
    expect(ams1117?.footprintVerified).toBe(true)
    // It is not enough to be in the results; it has to be the obvious answer.
    expect(results.indexOf(ams1117!)).toBeLessThan(3)
  })

  it("reports ready without any service running", async () => {
    const status = await index().status()
    expect(status).toMatchObject({ id: "local", status: "ready" })
    expect(status.count).toBe(T0_PARTS.length)
  })

  it("upsert is idempotent on id, so an ingestion job can be re-run", async () => {
    const store = new LocalPartsIndex()
    const part = T0_PARTS[0]!

    await store.upsert([part])
    await store.upsert([{ ...part, description: "second pass" }])

    expect((await store.status()).count).toBe(1)
    expect((await store.get(part.id))?.description).toBe("second pass")
  })

  it("removes only what it was asked to", async () => {
    const store = new LocalPartsIndex(T0_PARTS.slice(0, 3))
    const result = await store.remove([T0_PARTS[0]!.id, "not-a-part"])

    expect(result.removed).toBe(1)
    expect((await store.status()).count).toBe(2)
  })
})

describe("toMongoFilter", () => {
  it("requires every term, without caring which field matched", () => {
    const filter = toMongoFilter("ams1117 sot-223") as { $and: Array<{ $or: unknown[] }> }

    expect(filter.$and).toHaveLength(2)
    // Each term is an $or across the indexed fields: a query must not depend on the user
    // knowing whether "SOT-223" is stored as a package or mentioned in a description.
    expect(filter.$and[0]?.$or?.length).toBeGreaterThan(3)
  })

  it("escapes regex metacharacters in a query", () => {
    // MPNs are full of dots and dashes; "AMS1117-3.3" must not compile into a pattern
    // where "." matches anything.
    const filter = toMongoFilter("AMS1117-3.3") as {
      $and: Array<{ $or: Array<{ mpn?: { $regex: string } }> }>
    }
    expect(filter.$and[0]?.$or?.[0]?.mpn?.$regex).toBe("AMS1117-3\\.3")
  })

  it("drops single-character noise but keeps real terms", () => {
    const filter = toMongoFilter("a 3v3 ldo") as { $and: unknown[] }
    expect(filter.$and).toHaveLength(2)
  })

  it("turns a parameter range into a bounded query on the electrical fields", () => {
    const filter = toMongoFilter("", {
      params: { voltage_out: { min: 3.2, max: 3.4 } },
    }) as { $and: Array<Record<string, unknown>> }

    expect(filter.$and[0]).toEqual({ "electrical.voltage_out": { $gte: 3.2, $lte: 3.4 } })
  })

  it("uses equality when a parameter is exact", () => {
    const filter = toMongoFilter("", { params: { package_pins: { eq: 8 } } }) as {
      $and: Array<Record<string, unknown>>
    }
    expect(filter.$and[0]).toEqual({ "electrical.package_pins": 8 })
  })

  it("returns an empty query for an empty browse", () => {
    expect(toMongoFilter("")).toEqual({})
  })
})

/** A collection that records what it was asked and answers from a fixed list. */
const fakeCollection = (parts: PartDefinition[]) => {
  const calls: Array<{ filter: Record<string, unknown>; options?: { limit?: number } }> = []
  const collection: PartsCollectionLike & { calls: typeof calls; written: unknown[] } = {
    calls,
    written: [],
    find(filter, options) {
      calls.push({ filter, ...(options ? { options } : {}) })
      return { toArray: async () => parts }
    },
    async findOne(filter) {
      return parts.find((p) => p.id === (filter as { id?: string }).id) ?? null
    },
    async bulkWrite(operations) {
      collection.written.push(...(operations as unknown[]))
      return {}
    },
    async deleteMany(filter) {
      const ids = (filter as { id?: { $in?: string[] } }).id?.$in ?? []
      return { deletedCount: parts.filter((p) => ids.includes(p.id)).length }
    },
    async countDocuments() {
      return parts.length
    },
  }
  return collection
}

describe("MongoPartsIndex", () => {
  it("narrows in the database and ranks with the shared scorer", async () => {
    const collection = fakeCollection(T0_PARTS)
    const index = new MongoPartsIndex(collection)

    const results = await index.search("3.3V LDO SOT-223")

    // The database was asked a filter, not handed the whole catalog.
    expect(collection.calls[0]?.filter).toHaveProperty("$and")
    // And the ordering is the same one LocalPartsIndex produces, because the scorer is
    // the same code — an index must not have its own opinion about relevance.
    const local = await new LocalPartsIndex(T0_PARTS).search("3.3V LDO SOT-223")
    expect(results.map((r) => r.id)).toEqual(local.map((r) => r.id))
  })

  it("bounds how many candidates it will rank", async () => {
    const collection = fakeCollection(T0_PARTS)
    await new MongoPartsIndex(collection, { candidateLimit: 50 }).search("resistor")

    expect(collection.calls[0]?.options?.limit).toBe(50)
  })

  it("upserts by id so a re-run replaces rather than duplicates", async () => {
    const collection = fakeCollection([])
    await new MongoPartsIndex(collection).upsert([T0_PARTS[0]!])

    expect(collection.written[0]).toMatchObject({
      replaceOne: { filter: { id: T0_PARTS[0]!.id }, upsert: true },
    })
  })

  it("reports disabled rather than throwing when the database is unreachable", async () => {
    const broken = {
      ...fakeCollection([]),
      countDocuments: async () => {
        throw new Error("ECONNREFUSED")
      },
    }
    const status = await new MongoPartsIndex(broken).status()

    expect(status).toMatchObject({ id: "mongo", status: "disabled", detail: "ECONNREFUSED" })
  })
})

describe("MeiliPartsIndex", () => {
  it("reports disabled with no URL, and never throws for it", async () => {
    const index = new MeiliPartsIndex()

    // The `search` profile not running is the normal case, not a fault.
    expect(await index.status()).toMatchObject({ status: "disabled" })
    expect(await index.search("anything")).toEqual([])
    expect(await index.get("x")).toBeUndefined()
    expect(await index.upsert([T0_PARTS[0]!])).toEqual({ upserted: 0 })
  })

  it("builds filter expressions only for declared filterable attributes", () => {
    expect(toMeiliFilter({ category: "regulator", package: "SOT-223" })).toEqual([
      'category = "regulator"',
      'package = "SOT-223"',
    ])
    // Parameter ranges are not expressible without declaring every electrical field
    // filterable up front, so they are left to the Mongo and local indexes.
    expect(toMeiliFilter({ params: { voltage_out: { min: 3 } } })).toEqual([])
  })
})

describe("selectPartsIndex", () => {
  it("falls back to the local index when no collection is supplied", async () => {
    const index = selectPartsIndex({ fallbackParts: T0_PARTS })

    expect(index.id).toBe("local")
    // Falling back must still satisfy the acceptance criterion: a stack with no database
    // is a working stack.
    const results = await index.search("3.3V LDO SOT-223")
    expect(results.some((r) => (r.mpn ?? "").toUpperCase().startsWith("AMS1117"))).toBe(true)
  })

  it("uses Mongo when a collection is supplied", () => {
    expect(selectPartsIndex({ mongoCollection: fakeCollection([]) }).id).toBe("mongo")
  })
})
