/**
 * Parts the user defined themselves.
 *
 * The built-in T0 catalog is a fixed set of generic parts, and every other source is a
 * remote catalogue keyed on someone else's identifiers. Neither lets a person say "this
 * is the connector I actually have in a drawer, here are its pins". This is that store.
 *
 * **A JSON file, not a collection.** Custom parts must survive a restart, and the app is
 * a supported way to run with no `MONGO_URL` at all — so a Mongo-only store would make a
 * documented configuration silently lose the user's work. A file also means the library
 * is a thing you can copy, diff, put in version control and paste to a colleague, which a
 * row in a database is not. Writes are small and rare; the whole file is rewritten, and
 * that is the right trade at the scale one person's part library reaches.
 *
 * **Validation is the point, not a formality.** A custom part whose footprint does not
 * resolve is a board that does not fit its parts — the most expensive failure in this
 * domain. `validateUserPart` runs the real footprinter and returns the engine's own
 * errors, so the mistake surfaces in the form rather than at assembly.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  err,
  getLogger,
  ok,
  validationError,
  type Result,
  type ValidationError,
} from "@syntrix/shared"
import {
  partDefinitionSchema,
  type PartDefinition,
  type PartFilters,
  type PartSummary,
} from "./types"
import { searchParts, toSummary } from "./search"
import { resolveFootprint } from "./footprint"
import type { PartsIndex, PartsIndexStatus } from "./parts-index"

const log = getLogger("parts")

/** The prefix that marks a part as the user's own, everywhere it is shown. */
export const USER_PART_PREFIX = "user:"

/**
 * Where the library lives by default.
 *
 * Resolved against the repo root — found by walking up for the workspace marker — rather
 * than against `process.cwd()`. The api is started from `apps/api` by `scripts/dev.mjs`
 * and from `dist/` in production, so a cwd-relative path would put a different library in
 * a different place depending on how the process happened to be launched, and a user
 * would lose their parts on the first deployment. `SYNTRIX_DATA_DIR` overrides it.
 */
export const defaultUserPartsPath = (root?: string): string =>
  join(
    root ?? process.env["SYNTRIX_DATA_DIR"] ?? join(findRepoRoot(), "data"),
    "parts",
    "user-parts.json",
  )

/** The workspace root, or the cwd for an installation that is not a checkout. */
const findRepoRoot = (): string => {
  let current = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) return current
    const parent = dirname(current)
    if (parent === current) return process.cwd()
    current = parent
  }
}

/**
 * Check a part before it is stored.
 *
 * Returns *all* the problems rather than the first, because this backs a form and telling
 * someone about one mistake at a time is the worst way to fill one in.
 */
export const validateUserPart = (
  part: PartDefinition,
): Result<PartDefinition, ValidationError[]> => {
  const errors: ValidationError[] = []

  if (part.pins.length === 0) {
    errors.push(
      validationError(
        "PIN_MAP_INCOMPLETE",
        "A part needs at least one pin.",
        "Add the pins from the datasheet, with their numbers and names.",
        [part.id],
      ),
    )
  }

  const numbers = part.pins.map((pin) => String(pin.number))
  const duplicates = numbers.filter((n, i) => numbers.indexOf(n) !== i)
  if (duplicates.length > 0) {
    errors.push(
      validationError(
        "PIN_MAP_INCOMPLETE",
        `Pin number${duplicates.length > 1 ? "s" : ""} ${[...new Set(duplicates)].join(", ")} appear more than once.`,
        "Every pin number must be unique — they are how a connection names its endpoint.",
        [part.id],
      ),
    )
  }

  // A footprint is optional (a schematic-only part is legitimate), but one that was given
  // and does not resolve is not.
  const hasFootprint =
    part.footprint.footprinterString ||
    part.footprint.kicadModRef ||
    (part.footprint.circuitJsonElements?.length ?? 0) > 0

  if (hasFootprint) {
    const resolved = resolveFootprint(part.footprint)
    if (!resolved.ok) {
      errors.push(...resolved.error)
    } else if (resolved.value.padCount < part.pins.length) {
      // Fewer pads than pins means some pin has nowhere to solder. Caught here because
      // nothing downstream will notice until a board comes back from the fab.
      errors.push(
        validationError(
          "FOOTPRINT_UNRESOLVED",
          `The footprint has ${resolved.value.padCount} pad(s) but the part has ${part.pins.length} pin(s).`,
          "Pick a footprint with at least as many pads as the part has pins — 'soic8' rather than 'soic', for example.",
          [part.id],
        ),
      )
    }
  }

  return errors.length > 0 ? err(errors) : ok(part)
}

/**
 * Build a `PartDefinition` from the handful of fields a person can reasonably supply.
 *
 * The full schema has provenance, licensing, lifecycle and distributor blocks that matter
 * for a catalogue import and are noise in a form. They are filled in here, honestly: the
 * source is the user, and a footprint nobody checked is `unverified` — which is what puts
 * the warning next to it in the palette and tells the agent to mention it.
 */
export interface UserPartInput {
  id?: string
  name: string
  description?: string
  category?: string
  ftype?: string
  footprinterString?: string
  datasheetUrl?: string
  pins: Array<{
    number: number | string
    name: string
    kind?: PartDefinition["pins"][number]["kind"]
    altNames?: string[]
  }>
}

export const buildUserPart = (input: UserPartInput): Result<PartDefinition, ValidationError[]> => {
  const slug = (input.id ?? input.name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")

  if (slug.length === 0) {
    return err([
      validationError(
        "INVALID_PROP",
        "A part needs a name.",
        "Give it something you would recognise in the palette, such as 'My 4-pin header'.",
      ),
    ])
  }

  const parsed = partDefinitionSchema.safeParse({
    id: input.id?.startsWith(USER_PART_PREFIX) ? input.id : `${USER_PART_PREFIX}${slug}`,
    mpn: input.name.trim(),
    category: input.category?.trim() || "custom",
    description: input.description?.trim() || input.name.trim(),
    // Defaults to a generic chip: it is the ftype that accepts an arbitrary pin count,
    // so a part with five pins is representable without the user knowing what an ftype is.
    ftype: input.ftype?.trim() || "simple_chip",
    pins: input.pins.map((pin, index) => ({
      number: pin.number === "" || pin.number === undefined ? index + 1 : pin.number,
      name: pin.name.trim() || `pin${index + 1}`,
      kind: pin.kind ?? "passive",
      functions: [],
      altNames: pin.altNames ?? [],
    })),
    symbol: { source: "schematic-symbols", ref: "chip" },
    footprint: {
      ...(input.footprinterString?.trim()
        ? { footprinterString: input.footprinterString.trim() }
        : {}),
      // Never "verified". The user may well have checked it, but this flag means "checked
      // against a datasheet or a trusted library", and claiming that on their behalf is
      // how an unchecked land pattern reaches a fab.
      verification: "unverified",
    },
    electrical: {},
    ...(input.datasheetUrl?.trim() ? { datasheetUrl: input.datasheetUrl.trim() } : {}),
    distributors: [],
    lifecycle: "unknown",
    license: "user-supplied",
    provenance: { source: "user", fetchedAt: new Date().toISOString() },
    version: 1,
  })

  if (!parsed.success) {
    return err(
      parsed.error.issues.map((issue) =>
        validationError(
          "INVALID_PROP",
          `${issue.path.join(".") || "(part)"}: ${issue.message}`,
          "Check the field against the part form and try again.",
        ),
      ),
    )
  }

  return validateUserPart(parsed.data)
}

/**
 * The user's library, on disk.
 *
 * Reads once and keeps the parts in memory — the file is the durable copy, not the query
 * path. A library of a few hundred parts is a scan, exactly as `LocalPartsIndex` is, and
 * through the same scorer so a custom part ranks against a built-in one consistently.
 */
export class UserPartsIndex implements PartsIndex {
  readonly id = "user"
  private readonly parts = new Map<string, PartDefinition>()

  constructor(private readonly path: string) {
    this.load()
  }

  private load(): void {
    let raw: string
    try {
      raw = readFileSync(this.path, "utf8")
    } catch {
      // No file yet is the normal first run, not a problem to report.
      return
    }

    try {
      const parsed = JSON.parse(raw) as { parts?: unknown[] }
      for (const entry of parsed.parts ?? []) {
        const part = partDefinitionSchema.safeParse(entry)
        if (part.success) {
          this.parts.set(part.data.id, part.data)
        } else {
          // One malformed entry must not cost the user the rest of their library.
          log.warn(
            `Skipped an invalid custom part in ${this.path}: ${part.error.issues[0]?.message}`,
          )
        }
      }
    } catch (cause) {
      log.warn(
        `${this.path} is not valid JSON and was ignored: ${cause instanceof Error ? cause.message : String(cause)}`,
      )
    }
  }

  /**
   * Write the library out.
   *
   * Through a temporary file and a rename, which is atomic on every platform we run on.
   * A partial write here is the user's whole parts library truncated, and the window for
   * one is exactly as long as it takes to lose power mid-save.
   */
  private persist(): void {
    const body = JSON.stringify({ parts: [...this.parts.values()] }, undefined, 2)
    mkdirSync(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.tmp`
    writeFileSync(temporary, body, "utf8")
    renameSync(temporary, this.path)
  }

  async status(): Promise<PartsIndexStatus> {
    return { id: this.id, status: "ready", count: this.parts.size }
  }

  async search(query: string, filters?: PartFilters): Promise<PartSummary[]> {
    return searchParts([...this.parts.values()], query, filters).map((s) =>
      toSummary(s.part, this.id),
    )
  }

  async get(id: string): Promise<PartDefinition | undefined> {
    return this.parts.get(id)
  }

  /**
   * The synchronous lookup, for `createPartResolver`.
   *
   * Core resolves a `partRef` while applying an operation, and `apply` is a pure
   * synchronous function (principle: `apply(design, op)` is immutable and returns a new
   * `Design`). The library is already in memory, so this costs nothing — and without it a
   * custom part could be found in the palette and then not placed, which is the worst
   * possible half of the feature to ship.
   */
  lookup(id: string): PartDefinition | undefined {
    return this.parts.get(id)
  }

  async upsert(parts: PartDefinition[]): Promise<{ upserted: number }> {
    for (const part of parts) this.parts.set(part.id, part)
    this.persist()
    return { upserted: parts.length }
  }

  async remove(ids: string[]): Promise<{ removed: number }> {
    let removed = 0
    for (const id of ids) if (this.parts.delete(id)) removed += 1
    if (removed > 0) this.persist()
    return { removed }
  }

  all(): PartDefinition[] {
    return [...this.parts.values()]
  }
}

/**
 * A writable library layered over a read-only catalog.
 *
 * Presents one `PartsIndex` to the palette, the agent and MCP, so none of them needs to
 * know that some parts came from a file and some are built in — which is what makes a
 * custom part usable everywhere the moment it is saved, including by the agent.
 *
 * Writes always go to the overlay. The built-in catalog is not editable by design: it is
 * the thing a user's part is defined *against*, and a resistor that has been quietly
 * redefined is a debugging session nobody should have.
 */
export class CompositePartsIndex implements PartsIndex {
  readonly id = "composite"

  constructor(
    private readonly overlay: PartsIndex,
    private readonly base: PartsIndex,
  ) {}

  async status(): Promise<PartsIndexStatus> {
    const [overlay, base] = await Promise.all([this.overlay.status(), this.base.status()])
    return {
      id: this.id,
      status: "ready",
      count: (overlay.count ?? 0) + (base.count ?? 0),
      detail: `${overlay.count ?? 0} custom, ${base.count ?? 0} built in`,
    }
  }

  /**
   * Search both, the user's own parts first.
   *
   * Not interleaved by score: someone who has defined a part has expressed a preference
   * that a generic match should not out-rank. Within each group the shared scorer orders
   * as it does everywhere else.
   */
  async search(query: string, filters?: PartFilters): Promise<PartSummary[]> {
    const [mine, built] = await Promise.all([
      this.overlay.search(query, filters),
      this.base.search(query, filters),
    ])

    const seen = new Set(mine.map((part) => part.id))
    const merged = [...mine, ...built.filter((part) => !seen.has(part.id))]
    return filters?.limit ? merged.slice(0, filters.limit) : merged
  }

  async get(id: string): Promise<PartDefinition | undefined> {
    return (await this.overlay.get(id)) ?? (await this.base.get(id))
  }

  async upsert(parts: PartDefinition[]): Promise<{ upserted: number }> {
    return this.overlay.upsert(parts)
  }

  async remove(ids: string[]): Promise<{ removed: number }> {
    return this.overlay.remove(ids)
  }
}
