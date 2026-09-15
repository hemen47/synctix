/**
 * The Mongo-backed design store.
 *
 * Same contract as `MemoryDesignStore`, same semantics, and — importantly — the same
 * `replay` function derives a design from a log. The two stores differ in where the log
 * is kept and in nothing else, which is what stops "it works in dev" from meaning
 * anything different here.
 *
 * Two collections:
 *
 * - `designs` — one document per design: the record, plus a cached snapshot.
 * - `operations` — the append-only log, one document per entry, indexed by design and
 *   sequence.
 *
 * The snapshot is a cache and is treated as one. It is written alongside each operation so
 * opening a design does not mean replaying a thousand entries, and it is rebuilt from the
 * log whenever it is missing or stale. Deleting every snapshot must lose nothing —
 * `designs.test.ts` asserts exactly that against the memory store, and the property is a
 * consequence of the shared `replay`, not of either implementation.
 */

import {
  createRecordingIdFactory,
  err,
  newId,
  ok,
  validationError,
  withIdFactory,
  type Result,
  type ValidationError,
} from "@syntrix/shared"
import { apply, migrateDesign, type Design, type Operation } from "@syntrix/core"
import type { Collection } from "mongodb"
import type { DesignRecord, DesignStore, LogEntry } from "./store"
import { replay } from "./store"

interface DesignDoc extends DesignRecord {
  /** Cached fold of the log up to `version`. Rebuilt when absent. */
  snapshot?: Design
}

interface OperationDoc extends LogEntry {
  designId: string
}

export interface MongoStoreCollections {
  designs: Collection<DesignDoc>
  operations: Collection<OperationDoc>
}

export class MongoDesignStore implements DesignStore {
  constructor(
    private readonly collections: MongoStoreCollections,
    private readonly ctx?: Parameters<typeof apply>[2],
  ) {}

  /**
   * Indexes.
   *
   * `{ designId, seq }` unique is not an optimisation — it is what makes a concurrent
   * double-submit impossible to record twice. Two clients racing on the same version both
   * compute seq = n+1, and the database refuses the second, which is the outcome the
   * optimistic-concurrency check is trying to produce anyway.
   */
  async ensureIndexes(): Promise<void> {
    await this.collections.designs.createIndex({ id: 1 }, { unique: true })
    await this.collections.designs.createIndex({ updatedAt: -1 })
    await this.collections.operations.createIndex({ designId: 1, seq: 1 }, { unique: true })
  }

  async create(name: string): Promise<DesignRecord> {
    const now = new Date().toISOString()
    const record: DesignRecord = {
      id: newId("design"),
      name,
      createdAt: now,
      updatedAt: now,
      version: 0,
      logLength: 0,
    }
    await this.collections.designs.insertOne({ ...record })
    return record
  }

  async list(): Promise<DesignRecord[]> {
    const docs = await this.collections.designs
      .find({}, { projection: { _id: 0, snapshot: 0 } })
      .sort({ updatedAt: -1 })
      .limit(200)
      .toArray()
    return docs as DesignRecord[]
  }

  async get(id: string): Promise<{ record: DesignRecord; design: Design } | undefined> {
    const doc = await this.collections.designs.findOne({ id }, { projection: { _id: 0 } })
    if (!doc) return undefined

    const { snapshot, ...record } = doc
    const design =
      snapshot && snapshot.version === record.version ? snapshot : await this.rebuild(record)

    // Every read migrates, so a design written before v2 comes back correct without a
    // batch job (ADR-0013). Idempotent, so it costs nothing on a current document.
    return { record, design: migrateDesign(design).design }
  }

  async history(id: string): Promise<LogEntry[]> {
    const docs = await this.collections.operations
      .find({ designId: id }, { projection: { _id: 0, designId: 0 } })
      .sort({ seq: 1 })
      .toArray()
    return docs as LogEntry[]
  }

  async submit(
    id: string,
    operation: Operation,
    options: { expectedVersion?: number; actor?: LogEntry["actor"] } = {},
  ): Promise<Result<{ record: DesignRecord; design: Design }, ValidationError[]>> {
    const current = await this.get(id)
    if (!current) return err([notFound(id)])

    if (
      options.expectedVersion !== undefined &&
      options.expectedVersion !== current.record.version
    ) {
      return err([conflict(current.record.version, options.expectedVersion)])
    }

    const recorder = createRecordingIdFactory()
    const applied = withIdFactory(recorder, () => apply(current.design, operation, this.ctx))
    if (!applied.ok) return applied

    const seq = current.record.version + 1

    // A new edit after an undo discards the redo tail, exactly as in memory: the log
    // cannot branch, and leaving orphaned entries beyond the cursor would make `logLength`
    // lie about what is replayable.
    await this.collections.operations.deleteMany({ designId: id, seq: { $gte: seq } })

    try {
      await this.collections.operations.insertOne({
        designId: id,
        seq,
        operationId: newId("op"),
        operation,
        at: new Date().toISOString(),
        actor: options.actor ?? { kind: "user" },
        mintedIds: recorder.recorded(),
      })
    } catch (cause) {
      // The unique index fired: someone else got there first. That is a conflict, and the
      // caller should re-read rather than retry blindly.
      if (isDuplicateKey(cause)) {
        const latest = await this.get(id)
        return err([conflict(latest?.record.version ?? seq, options.expectedVersion ?? seq - 1)])
      }
      throw cause
    }

    const record: DesignRecord = {
      ...current.record,
      version: seq,
      logLength: seq,
      updatedAt: new Date().toISOString(),
    }
    await this.collections.designs.updateOne(
      { id },
      { $set: { ...record, snapshot: applied.value } },
    )

    return ok({ record, design: applied.value })
  }

  async undo(id: string) {
    return this.moveCursor(id, -1)
  }

  async redo(id: string) {
    return this.moveCursor(id, +1)
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.collections.designs.deleteOne({ id })
    await this.collections.operations.deleteMany({ designId: id })
    return (result.deletedCount ?? 0) > 0
  }

  /** Fold the log. The snapshot is a cache; this is the truth. */
  private async rebuild(record: DesignRecord): Promise<Design> {
    const log = await this.history(record.id)
    const replayed = replay(record.id, log, record.version, this.ctx)
    if (!replayed.ok) {
      throw new Error(replayed.error.map((e) => e.message).join(" | "))
    }
    await this.collections.designs.updateOne(
      { id: record.id },
      { $set: { snapshot: replayed.value } },
    )
    return replayed.value
  }

  private async moveCursor(
    id: string,
    delta: -1 | 1,
  ): Promise<Result<{ record: DesignRecord; design: Design }, ValidationError[]>> {
    const doc = await this.collections.designs.findOne({ id }, { projection: { _id: 0 } })
    if (!doc) return err([notFound(id)])

    const log = await this.history(id)
    const target = doc.version + delta

    if (target < 0 || target > log.length) {
      return err([
        validationError(
          "INVALID_OPERATION",
          delta < 0 ? "Nothing left to undo." : "Nothing to redo.",
          delta < 0
            ? "This design is already at its first state."
            : "Redo is only available after an undo, and a new edit discards it.",
        ),
      ])
    }

    const replayed = replay(id, log, target, this.ctx)
    if (!replayed.ok) return replayed

    const record: DesignRecord = {
      ...(doc as DesignRecord),
      version: target,
      updatedAt: new Date().toISOString(),
    }
    await this.collections.designs.updateOne(
      { id },
      { $set: { version: target, updatedAt: record.updatedAt, snapshot: replayed.value } },
    )

    return ok({ record, design: replayed.value })
  }
}

const isDuplicateKey = (cause: unknown): boolean =>
  typeof cause === "object" && cause !== null && (cause as { code?: number }).code === 11000

const notFound = (id: string): ValidationError =>
  validationError(
    "ELEMENT_NOT_FOUND",
    `No design with id "${id}".`,
    "List designs at GET /api/designs to find a valid id.",
  )

const conflict = (current: number, expected: number): ValidationError =>
  validationError(
    "VERSION_CONFLICT",
    `Design is at version ${current}, not ${expected}.`,
    "Someone else changed this design. Re-read it and re-apply your change.",
    [],
    { currentVersion: current, expectedVersion: expected },
  )
