/**
 * Local parts search.
 *
 * Mongo's text index owns T1 at scale, but T0 must be searchable with nothing running —
 * the engine has to work offline, and the M2 acceptance test has to be runnable in CI
 * against no database at all. So scoring lives here and every index applies these same
 * rules rather than inventing its own notion of relevance.
 *
 * The query language is what an engineer actually types: "3.3V LDO SOT-223",
 * "10k 0603 resistor", "dual op-amp". That means parsing voltages, packages and
 * abbreviations out of free text rather than matching whole strings.
 */

import type { PartDefinition, PartFilters, PartSummary } from "./types"

export interface ScoredPart {
  part: PartDefinition
  score: number
  /** Which query terms matched, for debugging a surprising result ordering. */
  matched: string[]
}

/** Abbreviations an engineer uses interchangeably with the catalog's own wording. */
const SYNONYMS: Record<string, string[]> = {
  ldo: ["low-dropout", "low dropout", "regulator", "linear regulator"],
  regulator: ["regulator", "ldo", "voltage regulator"],
  opamp: ["op-amp", "operational amplifier", "op amp"],
  "op-amp": ["op-amp", "operational amplifier", "opamp"],
  mcu: ["microcontroller"],
  uc: ["microcontroller"],
  cap: ["capacitor"],
  res: ["resistor"],
  xtal: ["crystal"],
  fet: ["mosfet"],
  pot: ["potentiometer"],
  led: ["led", "light emitting diode"],
  usb: ["usb"],
  uart: ["uart", "serial"],
}

/** Package names as written in queries, mapped to what the catalog records. */
const PACKAGE_ALIASES: Record<string, string[]> = {
  "sot-223": ["sot223", "sot-223"],
  sot223: ["sot223", "sot-223"],
  "sot-23": ["sot23", "sot-23"],
  sot23: ["sot23", "sot-23"],
  "soic-8": ["soic8", "soic-8"],
  soic8: ["soic8", "soic-8"],
  "to-220": ["to220", "to-220"],
  to220: ["to220", "to-220"],
  "tqfp-32": ["tqfp32", "tqfp-32"],
  "dip-8": ["dip8", "dip-8"],
}

const VOLTAGE_PATTERN = /^(\d+(?:\.\d+)?)\s*v$/i

const normalise = (text: string): string => text.toLowerCase().replace(/[_]/g, "-")

/** Everything about a part that free text should be able to hit. */
const searchableText = (part: PartDefinition): string =>
  normalise(
    [
      part.mpn ?? "",
      part.manufacturer ?? "",
      part.category,
      part.description,
      part.ftype,
      part.footprint.jedecPackage ?? "",
      part.footprint.footprinterString ?? "",
      ...Object.entries(part.electrical).map(([k, v]) => `${k} ${String(v)}`),
    ].join(" "),
  )

const expand = (term: string): string[] => {
  const expansions = new Set<string>([term])
  for (const alias of SYNONYMS[term] ?? []) expansions.add(normalise(alias))
  for (const alias of PACKAGE_ALIASES[term] ?? []) expansions.add(normalise(alias))
  // "sot-223" and "sot223" must both hit, whichever way the catalog spells it.
  if (term.includes("-")) expansions.add(term.replace(/-/g, ""))
  return [...expansions]
}

/**
 * Score one part against the query terms.
 *
 * The weighting reflects how specific a match is: an exact MPN hit is decisive, a package
 * or voltage match is strong evidence, and a description word is weak.
 */
const scorePart = (part: PartDefinition, terms: string[]): ScoredPart => {
  const haystack = searchableText(part)
  const mpn = normalise(part.mpn ?? "")
  const matched: string[] = []
  let score = 0

  for (const term of terms) {
    const variants = expand(term)
    let termScore = 0

    // Exact MPN: the user knows what they want.
    if (mpn && variants.some((v) => mpn === v)) termScore = Math.max(termScore, 100)
    else if (mpn && variants.some((v) => mpn.includes(v) && v.length >= 3)) {
      termScore = Math.max(termScore, 40)
    }

    // Voltage: "3.3V" should find a 3.3V regulator, which stores it as a number.
    const voltage = VOLTAGE_PATTERN.exec(term)
    if (voltage?.[1]) {
      const wanted = Number(voltage[1])
      const outputs = [part.electrical["voltage_out_v"], part.electrical["zener_voltage_v"]]
      if (outputs.some((v) => typeof v === "number" && Math.abs(v - wanted) < 0.01)) {
        termScore = Math.max(termScore, 30)
      }
    }

    // Package.
    const pkg = normalise(
      `${part.footprint.jedecPackage ?? ""} ${part.footprint.footprinterString ?? ""}`,
    )
    if (pkg && variants.some((v) => pkg.split(/\s+/).includes(v))) {
      termScore = Math.max(termScore, 25)
    }

    if (normalise(part.category).includes(term)) termScore = Math.max(termScore, 15)
    if (variants.some((v) => haystack.includes(v))) termScore = Math.max(termScore, 8)

    if (termScore > 0) {
      matched.push(term)
      score += termScore
    }
  }

  // A part matching every term beats one matching more terms weakly — "3.3V LDO SOT-223"
  // should not be won by a part that merely mentions regulators three times.
  if (matched.length === terms.length && terms.length > 1) score *= 1.5

  // Tie-break toward parts that will actually build: a verified footprint is the
  // difference between a board that fits and one that does not.
  //
  // Only applied to a part that matched something. Adding it unconditionally made every
  // verified part score above zero, so a query matching nothing returned the whole
  // catalogue.
  if (score > 0 && part.footprint.verification === "verified") score += 3

  return { part, score, matched }
}

export const matchesFilters = (part: PartDefinition, filters?: PartFilters): boolean => {
  if (!filters) return true

  if (filters.category && normalise(part.category) !== normalise(filters.category)) return false
  if (
    filters.manufacturer &&
    normalise(part.manufacturer ?? "") !== normalise(filters.manufacturer)
  ) {
    return false
  }

  if (filters.package) {
    const pkg = normalise(
      `${part.footprint.jedecPackage ?? ""} ${part.footprint.footprinterString ?? ""}`,
    )
    const wanted = expand(normalise(filters.package))
    if (!wanted.some((w) => pkg.split(/\s+/).includes(w))) return false
  }

  for (const [key, constraint] of Object.entries(filters.params ?? {})) {
    const value = part.electrical[key]
    if (constraint.eq !== undefined && value !== constraint.eq) return false
    if (typeof value !== "number") {
      // A range filter on a part that does not publish the parameter excludes it: a
      // maybe is not a match when the user asked for a specific range.
      if (constraint.min !== undefined || constraint.max !== undefined) return false
      continue
    }
    if (constraint.min !== undefined && value < constraint.min) return false
    if (constraint.max !== undefined && value > constraint.max) return false
  }

  return true
}

export const tokenize = (query: string): string[] =>
  normalise(query)
    .split(/[\s,]+/)
    .map((t) => t.replace(/^[^\w.+-]+|[^\w.+-]+$/g, ""))
    .filter((t) => t.length > 0)

/** Search a catalog. Pure, synchronous, and available with no services running. */
export const searchParts = (
  catalog: PartDefinition[],
  query: string,
  filters?: PartFilters,
): ScoredPart[] => {
  const terms = tokenize(query)
  const candidates = catalog.filter((part) => matchesFilters(part, filters))

  // An empty query with filters is a browse, not a search: return everything that passes
  // the filters rather than nothing.
  if (terms.length === 0) {
    return candidates
      .map((part) => ({ part, score: 1, matched: [] }))
      .slice(0, filters?.limit ?? 50)
  }

  return candidates
    .map((part) => scorePart(part, terms))
    .filter((scored) => scored.score > 0)
    .sort((a, b) => b.score - a.score || a.part.id.localeCompare(b.part.id))
    .slice(0, filters?.limit ?? 50)
}

export const toSummary = (part: PartDefinition, source = "t0"): PartSummary => ({
  id: part.id,
  ...(part.mpn ? { mpn: part.mpn } : {}),
  ...(part.manufacturer ? { manufacturer: part.manufacturer } : {}),
  description: part.description,
  category: part.category,
  ...(part.footprint.jedecPackage ? { package: part.footprint.jedecPackage } : {}),
  footprintVerified: part.footprint.verification === "verified",
  source,
})

/** Facet counts for the palette's filter UI. */
export const facetCounts = (
  parts: PartDefinition[],
): { categories: Record<string, number>; packages: Record<string, number> } => {
  const categories: Record<string, number> = {}
  const packages: Record<string, number> = {}

  for (const part of parts) {
    categories[part.category] = (categories[part.category] ?? 0) + 1
    const pkg = part.footprint.jedecPackage ?? part.footprint.footprinterString
    if (pkg) packages[pkg] = (packages[pkg] ?? 0) + 1
  }

  return { categories, packages }
}
