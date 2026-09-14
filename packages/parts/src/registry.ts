/**
 * Parts source registry and the bridge into core.
 *
 * Federated search merges results from every *ready* source. A source with no API key
 * reports `disabled` and is skipped — never an error, because a missing DigiKey key must
 * not break a search that T0 could have answered (principle: `status()` is on the
 * interface for exactly this reason).
 */

import type { Result, ValidationError } from "@syntrix/shared"
import { err, getLogger, ok, validationError } from "@syntrix/shared"
import type {
  PartDefinition,
  PartFilters,
  PartsSource,
  PartsSourceRegistry,
  PartSummary,
} from "./types"
import { T0_PARTS, getT0Part } from "./t0-catalog"
import { searchParts, toSummary } from "./search"

const log = getLogger("parts")

/** The built-in T0 source. Always ready: no network, no database, no key. */
export const t0Source: PartsSource = {
  id: "t0",
  label: "Generic parts",
  // Consulted first: a generic resistor should never be out-ranked by a catalogue hit
  // when the user just wants a resistor.
  priority: 0,
  status: () => "ready",
  search: async (query, filters) =>
    searchParts(T0_PARTS, query, filters).map((scored) => toSummary(scored.part, "t0")),
  fetch: async (sku) => getT0Part(sku),
}

export const createRegistry = (): PartsSourceRegistry => {
  const sources = new Map<string, PartsSource>()

  return {
    register(source) {
      if (sources.has(source.id)) {
        log.warn(`Parts source "${source.id}" was registered twice; the later one wins.`)
      }
      sources.set(source.id, source)
    },
    get: (id) => sources.get(id),
    active: () =>
      [...sources.values()]
        .filter((s) => s.status() === "ready")
        .sort((a, b) => a.priority - b.priority),
    list: () => [...sources.values()].sort((a, b) => a.priority - b.priority),
  }
}

export interface FederatedSearchResult {
  results: PartSummary[]
  /** Sources that were consulted, and what happened, so the UI can explain a thin result. */
  sources: Array<{
    id: string
    status: "ready" | "disabled" | "failed"
    count: number
    detail?: string
  }>
}

/**
 * Search every ready source and merge.
 *
 * A source that throws is reported as `failed` and the others still answer — one
 * misbehaving distributor API must not take the search down.
 */
export const federatedSearch = async (
  registry: PartsSourceRegistry,
  query: string,
  filters?: PartFilters,
): Promise<FederatedSearchResult> => {
  const report: FederatedSearchResult["sources"] = []
  const merged: PartSummary[] = []
  const seen = new Set<string>()

  for (const source of registry.list()) {
    if (source.status() === "disabled") {
      report.push({
        id: source.id,
        status: "disabled",
        count: 0,
        detail: source.disabledReason?.() ?? "not configured",
      })
      continue
    }

    try {
      const results = await source.search(query, filters)
      let added = 0
      for (const result of results) {
        // Higher-priority sources win on a duplicate MPN, which is why `list()` is
        // ordered and the loop does not run in parallel.
        const key = (result.mpn ?? result.id).toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        merged.push(result)
        added += 1
      }
      report.push({ id: source.id, status: "ready", count: added })
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      log.warn(`Parts source "${source.id}" failed during search`, { detail })
      report.push({ id: source.id, status: "failed", count: 0, detail })
    }
  }

  return { results: merged.slice(0, filters?.limit ?? 50), sources: report }
}

export const getPart = async (
  registry: PartsSourceRegistry,
  idOrMpn: string,
): Promise<Result<PartDefinition, ValidationError[]>> => {
  for (const source of registry.active()) {
    try {
      const part = await source.fetch(idOrMpn)
      if (part) return ok(part)
    } catch (cause) {
      log.warn(`Parts source "${source.id}" failed fetching "${idOrMpn}"`, {
        detail: cause instanceof Error ? cause.message : String(cause),
      })
    }
  }

  const disabled = registry
    .list()
    .filter((s) => s.status() === "disabled")
    .map((s) => s.id)

  return err([
    validationError(
      "PART_NOT_FOUND",
      `No part matching "${idOrMpn}" was found.`,
      disabled.length > 0
        ? `Searched ${registry.active().length} source(s). These are disabled and were skipped: ${disabled.join(", ")} — configure their API keys to widen the search.`
        : "Search for the part first to find its exact id, or add it with a generic ftype.",
      [],
      { disabled },
    ),
  ])
}

/**
 * Adapt a `PartDefinition` into what core's `apply` needs.
 *
 * This is the whole surface between parts and core: core never imports `@syntrix/parts`,
 * it receives this function. Pin `altNames` become `port_hints`, which is what makes
 * `connect({ component: "U1", pin: "VOUT" })` resolve.
 */
export const createPartResolver =
  (lookup: (partRef: string) => PartDefinition | undefined) => (partRef: string) => {
    const part = lookup(partRef)
    if (!part) return undefined

    return {
      ftype: part.ftype,
      spec: {
        pins: part.pins.map((pin) => ({
          number: typeof pin.number === "number" ? pin.number : Number(pin.number) || 1,
          name: pin.name,
          hints: [...new Set([String(pin.number), pin.name, ...pin.altNames])],
        })),
        // Only two-terminal passives are interchangeable; anything with a named pinout
        // is not, and ERC needs to know the difference.
        pinsInterchangeable: part.pins.length === 2 && part.pins.every((p) => p.kind === "passive"),
        ...valuePropFor(part.ftype),
      },
    }
  }

/** Which circuit-json property carries this ftype's primary value. */
const valuePropFor = (ftype: string): { valueProp?: string; valueUnit?: string } => {
  switch (ftype) {
    case "simple_resistor":
      return { valueProp: "resistance", valueUnit: "Ω" }
    case "simple_capacitor":
      return { valueProp: "capacitance", valueUnit: "F" }
    case "simple_inductor":
      return { valueProp: "inductance", valueUnit: "H" }
    case "simple_voltage_source":
    case "simple_power_source":
      return { valueProp: "voltage", valueUnit: "V" }
    default:
      return {}
  }
}

/** A registry with T0 registered — the default for any app that has not configured more. */
export const createDefaultRegistry = (): PartsSourceRegistry => {
  const registry = createRegistry()
  registry.register(t0Source)
  return registry
}

/** Resolver over T0 alone, for offline use and tests. */
export const t0Resolver = createPartResolver(getT0Part)
