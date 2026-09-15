/**
 * KiCad footprint libraries.
 *
 * KiCad's `.pretty` libraries are the most carefully reviewed open footprint collection
 * there is, and every one of them is a plain `.kicad_mod` file on disk. That makes this
 * the one parts source with no network, no key and no rate limit — which is why it is
 * worth having even though LCSC covers more parts.
 *
 * `kicad-mod-converter` does the parsing: `parseKicadModToTscircuitSoup(text)` returns
 * circuit-json pads and silkscreen directly.
 *
 * **Licensing.** kicad-footprints is CC-BY-SA 4.0 *with an exception* stating that using
 * a footprint in a design does not make the design a derivative work. That exception is
 * the reason this is usable at all, and it is recorded per part rather than assumed, so
 * the BOM can surface it (principle 9, and open question 3).
 */

import { readdir, readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { basename, join } from "node:path"
import { partDefinitionSchema } from "./types"
import type { PartDefinition, PartFilters, PartSummary, PartsSource } from "./types"

const KICAD_LICENSE =
  "CC-BY-SA 4.0 with the KiCad Library exception: using a footprint in a design does " +
  "not make the design a derivative work. See kicad-footprints/LICENSE.md."

export interface KicadSourceOptions {
  /** A checkout of kicad-footprints, i.e. a directory of `*.pretty` folders. */
  footprintsPath?: string
  /** Cap the directory walk; the full library is ~15k files. */
  maxResults?: number
}

interface FootprintRef {
  /** "Package_TO_SOT_SMD:SOT-223-3" — KiCad's own library:name form. */
  ref: string
  library: string
  name: string
  path: string
}

export class KicadLibrarySource implements PartsSource {
  readonly id = "kicad"
  readonly label = "KiCad footprint library"
  readonly priority = 30

  private index?: FootprintRef[]

  constructor(private readonly options: KicadSourceOptions = {}) {}

  private get root(): string | undefined {
    const path = this.options.footprintsPath ?? process.env["KICAD_FOOTPRINTS_PATH"]
    return path && existsSync(path) ? path : undefined
  }

  status(): "ready" | "disabled" {
    return this.root ? "ready" : "disabled"
  }

  disabledReason(): string | undefined {
    if (this.root) return undefined
    return (
      "No KiCad footprint library found. Run `make kicad-libs` to clone it, or set " +
      "KICAD_FOOTPRINTS_PATH."
    )
  }

  async search(query: string, filters?: PartFilters): Promise<PartSummary[]> {
    const entries = await this.ensureIndex()
    if (entries.length === 0) return []

    const terms = query
      .toLowerCase()
      .split(/[\s_-]+/)
      .filter((t) => t.length > 1)

    const scored = entries
      .map((entry) => ({ entry, score: scoreRef(entry, terms) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, filters?.limit ?? 25)

    return scored.map(({ entry }) => ({
      id: `kicad:${entry.ref}`,
      description: entry.name.replace(/[_-]/g, " "),
      category: categoryFromLibrary(entry.library),
      package: entry.name,
      // The KiCad libraries are reviewed against manufacturer drawings by people whose
      // whole job is that review. This is the one source where "verified" is not a claim
      // we are making ourselves.
      footprintVerified: true,
      source: "kicad",
    }))
  }

  async fetch(sku: string): Promise<PartDefinition | undefined> {
    const ref = sku.replace(/^kicad:/, "")
    const entries = await this.ensureIndex()
    const entry = entries.find((e) => e.ref === ref)
    if (!entry) return undefined

    const text = await readFile(entry.path, "utf8")
    const { parseKicadModToTscircuitSoup } = await import("kicad-mod-converter")
    const elements = (await parseKicadModToTscircuitSoup(text)) as unknown[]

    const pads = (elements as Array<Record<string, unknown>>).filter((e) =>
      String(e["type"] ?? "").startsWith("pcb_"),
    )

    return partDefinitionSchema.parse({
      id: `kicad:${entry.ref}`,
      category: categoryFromLibrary(entry.library),
      description: entry.name.replace(/[_-]/g, " "),
      // A footprint is not a component: it has no pinout and no function. It is offered
      // as a footprint for a part the user already chose, which is why the ftype is the
      // generic one.
      ftype: "simple_chip",
      pins: [],
      symbol: { source: "kicad", ref: entry.ref },
      footprint: {
        verification: pads.length > 0 ? "verified" : "unverified",
        kicadModRef: entry.ref,
        circuitJsonElements: pads,
      },
      electrical: {},
      license: KICAD_LICENSE,
      provenance: {
        source: "kicad-footprints",
        fetchedAt: new Date().toISOString(),
        sourceUrl: `https://gitlab.com/kicad/libraries/kicad-footprints/-/blob/master/${entry.library}.pretty/${entry.name}.kicad_mod`,
      },
    })
  }

  /** Walk the library once and keep the list. ~15k files; one pass is plenty. */
  private async ensureIndex(): Promise<FootprintRef[]> {
    if (this.index) return this.index
    const root = this.root
    if (!root) {
      this.index = []
      return this.index
    }

    const found: FootprintRef[] = []
    const libraries = await readdir(root, { withFileTypes: true })

    for (const library of libraries) {
      if (!library.isDirectory() || !library.name.endsWith(".pretty")) continue
      const libraryName = library.name.replace(/\.pretty$/, "")

      for (const file of await readdir(join(root, library.name))) {
        if (!file.endsWith(".kicad_mod")) continue
        const name = basename(file, ".kicad_mod")
        found.push({
          ref: `${libraryName}:${name}`,
          library: libraryName,
          name,
          path: join(root, library.name, file),
        })
      }
    }

    this.index = found
    return found
  }
}

/** Every term must appear somewhere; an exact package name wins. */
const scoreRef = (entry: FootprintRef, terms: string[]): number => {
  if (terms.length === 0) return 0
  const haystack = `${entry.library} ${entry.name}`.toLowerCase()
  if (!terms.every((term) => haystack.includes(term))) return 0

  const name = entry.name.toLowerCase()
  if (terms.length === 1 && name === terms[0]) return 100
  if (terms.some((term) => name.startsWith(term))) return 50
  return 10
}

const categoryFromLibrary = (library: string): string => {
  const text = library.toLowerCase()
  if (text.includes("resistor")) return "Resistor"
  if (text.includes("capacitor")) return "Capacitor"
  if (text.includes("inductor")) return "Inductor"
  if (text.includes("connector")) return "Connector"
  if (text.includes("led")) return "LED"
  if (text.includes("diode")) return "Diode"
  if (text.includes("crystal")) return "Timing"
  if (text.includes("button") || text.includes("switch")) return "Switch"
  return "Package"
}
