/**
 * Persistence: an append-only operation log, and snapshots derived from it.
 *
 * Principle 7 in practice. The log is the truth; a design is what you get by folding
 * `apply` over it. Snapshots exist so that opening a design does not mean replaying a
 * thousand operations, and they are a cache — deleting every snapshot must lose nothing.
 *
 * Undo is not an inverse operation. There is no `unconnect` that undoes a `connect`,
 * because an inverse has to know what the world looked like before, and that is exactly
 * what the log already records. Undo moves a cursor back along the log and replays; redo
 * moves it forward. That makes undo total — every operation is undoable, including a
 * batch and a TSX merge — which an inverse-operation scheme never quite manages.
 */

import { apply, createDesign, migrateDesign, type Design, type Operation } from "@syntrix/core"
import type { Result, ValidationError } from "@syntrix/shared"
import {
  createRecordingIdFactory,
  createReplayIdFactory,
  err,
  newId,
  ok,
  validationError,
  withIdFactory,
} from "@syntrix/shared"

export interface LogEntry {
  /** Position in the log, from 1. The design's `version` after this entry was applied. */
  seq: number
  operationId: string
  operation: Operation
  at: string
  /** Who asked for it — a user action, an agent turn, an import. */
  actor: { kind: "user" | "agent" | "import" | "system"; runId?: string }
  /**
   * Element ids this operation minted, in generation order.
   *
   * Without this, replaying the log produces a design that is structurally identical and
   * has different ids — which orphans the id-keyed `meta` sidecar and invalidates every
   * id a client is holding. Undo would break both, silently. Recording them makes replay
   * reproduce the original exactly rather than merely equivalently.
   */
  mintedIds: string[]
  /** Set when undo has moved the cursor back past this entry. Redo clears it. */
  undone?: boolean
}

export interface DesignRecord {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  /** Cursor into the log: how many entries are currently in effect. */
  version: number
  /** Total entries, including undone ones beyond the cursor. */
  logLength: number
}

export interface DesignStore {
  create(name: string): Promise<DesignRecord>
  list(): Promise<DesignRecord[]>
  get(id: string): Promise<{ record: DesignRecord; design: Design } | undefined>
  history(id: string): Promise<LogEntry[]>
  /**
   * Apply one operation and append it.
   *
   * `expectedVersion` is optimistic concurrency: two clients editing the same design
   * must not silently overwrite each other, and the second one deserves a conflict it
   * can act on rather than a design that quietly lost an edit.
   */
  submit(
    id: string,
    operation: Operation,
    options?: { expectedVersion?: number; actor?: LogEntry["actor"] },
  ): Promise<Result<{ record: DesignRecord; design: Design }, ValidationError[]>>
  undo(id: string): Promise<Result<{ record: DesignRecord; design: Design }, ValidationError[]>>
  redo(id: string): Promise<Result<{ record: DesignRecord; design: Design }, ValidationError[]>>
  delete(id: string): Promise<boolean>
}

interface StoredDesign {
  record: DesignRecord
  log: LogEntry[]
  /** Cached fold of the log up to `record.version`. */
  snapshot?: Design
}

/**
 * Replay the log to a cursor.
 *
 * The one place the derivation happens, so an in-memory store and a Mongo store cannot
 * disagree about what a log means.
 */
export const replay = (
  designId: string,
  log: LogEntry[],
  upTo: number,
  ctx?: Parameters<typeof apply>[2],
): Result<Design, ValidationError[]> => {
  let design = createDesign(designId)

  for (const entry of log) {
    if (entry.seq > upTo) break
    // Hand back the ids this operation minted the first time, in the same order.
    const result = withIdFactory(createReplayIdFactory(entry.mintedIds ?? []), () =>
      apply(design, entry.operation, ctx),
    )
    if (!result.ok) {
      // A log entry that no longer applies means the log and the engine have diverged —
      // a bug, not a user error. Say which entry, because replaying to find it by hand is
      // the worst possible debugging session.
      return err([
        validationError(
          "CIRCUIT_JSON_INVALID",
          `Operation ${entry.seq} (${entry.operation.type}) no longer applies: ${result.error[0]?.message}`,
          "The operation log and the engine have diverged. This is a bug in SYNTRIX.",
          [],
          { seq: entry.seq, operationId: entry.operationId },
        ),
      ])
    }
    design = result.value
  }

  return ok(design)
}

/**
 * The in-memory store.
 *
 * Not a test double: it is what a development stack with no `MONGO_URL` runs on, the same
 * way `LocalPartsIndex` is. That keeps the no-database path exercised rather than
 * theoretical.
 */
export class MemoryDesignStore implements DesignStore {
  private readonly designs = new Map<string, StoredDesign>()

  constructor(private readonly ctx?: Parameters<typeof apply>[2]) {}

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
    this.designs.set(record.id, { record, log: [], snapshot: createDesign(record.id) })
    return record
  }

  async list(): Promise<DesignRecord[]> {
    return [...this.designs.values()]
      .map((d) => d.record)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async get(id: string): Promise<{ record: DesignRecord; design: Design } | undefined> {
    const stored = this.designs.get(id)
    if (!stored) return undefined

    const design =
      stored.snapshot ?? unwrap(replay(id, stored.log, stored.record.version, this.ctx))
    stored.snapshot = design
    // Every read goes through the migration, so a design written before v2 comes back
    // correct without a batch job (ADR-0013). It is idempotent, so this costs nothing.
    return { record: stored.record, design: migrateDesign(design).design }
  }

  async history(id: string): Promise<LogEntry[]> {
    return this.designs.get(id)?.log ?? []
  }

  async submit(
    id: string,
    operation: Operation,
    options: { expectedVersion?: number; actor?: LogEntry["actor"] } = {},
  ): Promise<Result<{ record: DesignRecord; design: Design }, ValidationError[]>> {
    const stored = this.designs.get(id)
    if (!stored) return err([notFound(id)])

    if (
      options.expectedVersion !== undefined &&
      options.expectedVersion !== stored.record.version
    ) {
      return err([
        validationError(
          "VERSION_CONFLICT",
          `Design is at version ${stored.record.version}, not ${options.expectedVersion}.`,
          "Someone else changed this design. Re-read it and re-apply your change.",
          [],
          { currentVersion: stored.record.version, expectedVersion: options.expectedVersion },
        ),
      ])
    }

    const current = (await this.get(id))!.design
    const recorder = createRecordingIdFactory()
    const result = withIdFactory(recorder, () => apply(current, operation, this.ctx))
    if (!result.ok) return result

    // Submitting after an undo discards the redo tail. That is what every editor does, and
    // keeping it would mean the log branched, which the replay model has no room for.
    const kept = stored.log.filter((entry) => entry.seq <= stored.record.version)
    const seq = stored.record.version + 1

    kept.push({
      seq,
      operationId: newId("op"),
      operation,
      at: new Date().toISOString(),
      actor: options.actor ?? { kind: "user" },
      mintedIds: recorder.recorded(),
    })

    stored.log = kept
    stored.record = {
      ...stored.record,
      version: seq,
      logLength: kept.length,
      updatedAt: new Date().toISOString(),
    }
    stored.snapshot = result.value

    return ok({ record: stored.record, design: result.value })
  }

  async undo(
    id: string,
  ): Promise<Result<{ record: DesignRecord; design: Design }, ValidationError[]>> {
    return this.moveCursor(id, -1)
  }

  async redo(
    id: string,
  ): Promise<Result<{ record: DesignRecord; design: Design }, ValidationError[]>> {
    return this.moveCursor(id, +1)
  }

  async delete(id: string): Promise<boolean> {
    return this.designs.delete(id)
  }

  private async moveCursor(
    id: string,
    delta: -1 | 1,
  ): Promise<Result<{ record: DesignRecord; design: Design }, ValidationError[]>> {
    const stored = this.designs.get(id)
    if (!stored) return err([notFound(id)])

    const target = stored.record.version + delta
    if (target < 0 || target > stored.log.length) {
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

    const replayed = replay(id, stored.log, target, this.ctx)
    if (!replayed.ok) return replayed

    stored.record = {
      ...stored.record,
      version: target,
      updatedAt: new Date().toISOString(),
    }
    stored.snapshot = replayed.value
    for (const entry of stored.log) entry.undone = entry.seq > target

    return ok({ record: stored.record, design: replayed.value })
  }
}

const notFound = (id: string): ValidationError =>
  validationError(
    "ELEMENT_NOT_FOUND",
    `No design with id "${id}".`,
    "List designs at GET /api/designs to find a valid id.",
  )

const unwrap = <T>(result: Result<T, ValidationError[]>): T => {
  if (!result.ok) throw new Error(result.error.map((e) => e.message).join(" | "))
  return result.value
}
