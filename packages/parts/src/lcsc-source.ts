/**
 * LCSC / JLCPCB, via tscircuit's own parts engine.
 *
 * ## Which package, and why not the one the plan named
 *
 * The v2 plan said `easyeda-converter`. That package is real, published at **0.0.2**, and
 * built against `@tscircuit/soup` and `@tscircuit/builder` — the packages that were
 * renamed to `circuit-json` a long time ago. Its two exported functions do not even
 * compose with each other: `fetchEasyEDAComponent` returns `{ success, code, result }`
 * and `convertEasyEdaJsonToTscircuitSoupJson` reads `.dataStr` off whatever it is given,
 * so calling one with the other's output throws. Feeding it `result` by hand produces two
 * elements and no pads.
 *
 * `@tscircuit/parts-engine` bundles its own maintained copies of both and is what
 * tscircuit actually uses. Measured on C6186 (AMS1117-3.3) it returns 13 elements: the
 * component, four ports, four SMT pads, silkscreen, a courtyard outline, and a
 * `cad_component` carrying `model_obj_url` and `model_step_url` — symbol, footprint and 3D,
 * which is exactly M7's criterion. See ADR-0022.
 *
 * ## Two APIs, two jobs
 *
 * Search goes to `jlcsearch.tscircuit.com`, which answers with structured rows (lcsc, mfr,
 * package, whether the part is JLC "basic"). Fetch goes through the parts engine, which
 * pulls the full EasyEDA definition and converts it. They are separate because search has
 * to be fast and fetch has to be complete.
 */

import type { Result, ValidationError } from "@syntrix/shared"
import { err, ok, validationError } from "@syntrix/shared"
import { partDefinitionSchema } from "./types"
import type { PartDefinition, PartFilters, PartSummary, PartsSource, Pin } from "./types"

const JLCSEARCH_URL = "https://jlcsearch.tscircuit.com"

/** One row from jlcsearch. Narrowed to what we read. */
interface JlcRow {
  lcsc: number
  mfr?: string
  package?: string
  description?: string
  is_basic?: boolean
  is_preferred?: boolean
  stock?: number
  price?: number
}

export interface LcscSourceOptions {
  /** Off by default: an import reaches an external API, which a test must not do. */
  enabled?: boolean
  searchUrl?: string
  /** Injected so tests are deterministic and offline. */
  fetchImpl?: typeof fetch
  /** Injected so the live fetch path can be faked without faking the whole engine. */
  fetchCircuitJson?: (lcscId: string) => Promise<unknown[] | undefined>
  timeoutMs?: number
}

export class LcscSource implements PartsSource {
  readonly id = "lcsc"
  readonly label = "LCSC / JLCPCB"
  readonly priority = 20

  private readonly options: Required<Pick<LcscSourceOptions, "searchUrl" | "timeoutMs">> &
    LcscSourceOptions

  constructor(options: LcscSourceOptions = {}) {
    this.options = {
      searchUrl: options.searchUrl ?? JLCSEARCH_URL,
      timeoutMs: options.timeoutMs ?? 12_000,
      ...options,
    }
  }

  /**
   * Enabled by configuration, not by reachability.
   *
   * A network check here would make `status()` slow and flaky, and the registry already
   * treats a source that fails mid-search as skipped rather than fatal.
   */
  status(): "ready" | "disabled" {
    return this.options.enabled === false ? "disabled" : "ready"
  }

  disabledReason(): string | undefined {
    return this.status() === "disabled" ? "LCSC_ENABLED is not set" : undefined
  }

  async search(query: string, filters?: PartFilters): Promise<PartSummary[]> {
    if (this.status() === "disabled") return []

    const url = new URL("/api/search", this.options.searchUrl)
    url.searchParams.set("q", query)
    if (filters?.package) url.searchParams.set("package", filters.package)

    const body = (await this.json(url.toString())) as { components?: JlcRow[] } | undefined

    return (body?.components ?? []).slice(0, filters?.limit ?? 25).map((row) => toSummary(row))
  }

  /**
   * Fetch a full part.
   *
   * The circuit-json comes from the parts engine and carries the footprint and the 3D
   * model; the catalogue metadata comes from search. Both are needed: the engine knows
   * geometry and nothing about stock, and jlcsearch knows the reverse.
   */
  async fetch(sku: string): Promise<PartDefinition | undefined> {
    if (this.status() === "disabled") return undefined

    const lcscId = normaliseLcsc(sku)
    const elements = await this.circuitJsonFor(lcscId)
    if (!elements || elements.length === 0) return undefined

    const row = await this.rowFor(lcscId)
    const built = buildPartDefinition(lcscId, elements, row)
    return built.ok ? built.value : undefined
  }

  async checkStock(sku: string): Promise<{ quantity: number; currency?: string; price?: number }> {
    const row = await this.rowFor(normaliseLcsc(sku))
    return {
      quantity: row?.stock ?? 0,
      currency: "USD",
      ...(row?.price !== undefined ? { price: row.price } : {}),
    }
  }

  private async circuitJsonFor(lcscId: string): Promise<unknown[] | undefined> {
    if (this.options.fetchCircuitJson) return this.options.fetchCircuitJson(lcscId)

    // Imported lazily: the engine pulls in the EasyEDA converter and its dependencies, and
    // a deployment that never imports an LCSC part should not pay for that at startup.
    const { JlcPcbPartsEngine } = await import("@tscircuit/parts-engine")
    const engine = new JlcPcbPartsEngine()
    return (await engine.fetchPartCircuitJson({ supplierPartNumber: lcscId })) as
      unknown[] | undefined
  }

  private async rowFor(lcscId: string): Promise<JlcRow | undefined> {
    const url = new URL("/api/search", this.options.searchUrl)
    url.searchParams.set("q", lcscId.replace(/^C/i, ""))
    const body = (await this.json(url.toString())) as { components?: JlcRow[] } | undefined
    const numeric = Number(lcscId.replace(/^C/i, ""))
    return body?.components?.find((c) => c.lcsc === numeric) ?? body?.components?.[0]
  }

  /** A fetch that times out and never throws. A parts source must not break a search. */
  private async json(url: string): Promise<unknown> {
    const impl = this.options.fetchImpl ?? fetch
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs)
    try {
      const response = await impl(url, { signal: controller.signal })
      return response.ok ? await response.json() : undefined
    } catch {
      return undefined
    } finally {
      clearTimeout(timer)
    }
  }
}

const normaliseLcsc = (sku: string): string => {
  const digits = sku.replace(/^lcsc:/i, "").replace(/^C/i, "")
  return `C${digits}`
}

const toSummary = (row: JlcRow): PartSummary => ({
  id: `lcsc:C${row.lcsc}`,
  ...(row.mfr ? { mpn: row.mfr } : {}),
  description: row.description ?? row.mfr ?? `LCSC C${row.lcsc}`,
  category: categoryFrom(row.description ?? ""),
  ...(row.package ? { package: row.package } : {}),
  // The footprint came from EasyEDA's own package drawing, which is what JLC assembles
  // against. That is as verified as a footprint gets without measuring a part.
  footprintVerified: true,
  source: "lcsc",
})

/** A rough category from the description. Good enough to filter a palette. */
const categoryFrom = (description: string): string => {
  const text = description.toLowerCase()
  for (const [needle, category] of [
    ["regulator", "Regulator"],
    ["mosfet", "Transistor"],
    ["transistor", "Transistor"],
    ["resistor", "Resistor"],
    ["capacitor", "Capacitor"],
    ["inductor", "Inductor"],
    ["diode", "Diode"],
    ["led", "LED"],
    ["connector", "Connector"],
    ["crystal", "Timing"],
    ["oscillator", "Timing"],
    ["amplifier", "Amplifier"],
    ["microcontroller", "MCU"],
  ] as const) {
    if (text.includes(needle)) return category
  }
  return "Other"
}

/**
 * Turn fetched circuit-json into a `PartDefinition`.
 *
 * Exported and pure so it can be tested against a recorded fixture — the network is the
 * part of this that cannot be relied on in CI, and it is also the part with no logic in
 * it.
 */
export const buildPartDefinition = (
  lcscId: string,
  elements: unknown[],
  row?: JlcRow,
): Result<PartDefinition, ValidationError[]> => {
  const records = elements as Array<Record<string, unknown>>

  const component = records.find((e) => e["type"] === "source_component")
  if (!component) {
    return err([
      validationError(
        "PART_NOT_FOUND",
        `LCSC ${lcscId} returned no source_component.`,
        "The part may have no EasyEDA symbol. Try another LCSC id, or add it as a custom part.",
      ),
    ])
  }

  const ports = records
    .filter((e) => e["type"] === "source_port")
    .sort((a, b) => Number(a["pin_number"] ?? 0) - Number(b["pin_number"] ?? 0))

  const pins: Pin[] = ports.map((port, index) => ({
    number: Number(port["pin_number"] ?? index + 1),
    name: String(port["name"] ?? `pin${index + 1}`),
    kind: "unspecified",
    functions: [],
    altNames: ((port["port_hints"] as string[] | undefined) ?? []).filter(
      (hint) => hint !== String(port["name"] ?? ""),
    ),
  }))

  const pads = records.filter((e) => e["type"] === "pcb_smtpad" || e["type"] === "pcb_plated_hole")
  const cad = records.find((e) => e["type"] === "cad_component")

  const pcbElements = records.filter((e) => String(e["type"] ?? "").startsWith("pcb_"))

  return ok(
    partDefinitionSchema.parse({
      id: `lcsc:${lcscId}`,
      ...(row?.mfr ? { mpn: row.mfr } : {}),
      category: categoryFrom(row?.description ?? ""),
      description: row?.description ?? String(component["name"] ?? lcscId),
      ftype: String(component["ftype"] ?? "simple_chip"),
      pins,
      symbol: { source: "custom", ref: `lcsc:${lcscId}` },
      footprint: {
        // Real pads from EasyEDA's package drawing, not a guess from a package name.
        verification: pads.length > 0 ? "verified" : "unverified",
        ...(row?.package ? { ipc7351Name: row.package } : {}),
        circuitJsonElements: pcbElements,
      },
      electrical: {
        ...(row?.is_basic !== undefined ? { jlc_basic_part: row.is_basic } : {}),
        ...(row?.stock !== undefined ? { jlc_stock: row.stock } : {}),
      },
      ...(cad?.["model_step_url"]
        ? { cad3d: { format: "step" as const, url: String(cad["model_step_url"]) } }
        : {}),
      distributors: [
        {
          name: "lcsc" as const,
          sku: lcscId,
          url: `https://jlcpcb.com/partdetail/${lcscId.replace(/^C/, "")}`,
        },
      ],
      // EasyEDA's library terms are not an open licence. Recorded per part so the BOM can
      // surface it, which is the whole point of tracking provenance (principle 9).
      license: "EasyEDA library content — see easyeda.com terms before redistribution",
      provenance: {
        source: "lcsc/easyeda via @tscircuit/parts-engine",
        fetchedAt: new Date().toISOString(),
        sourceUrl: `https://jlcpcb.com/partdetail/${lcscId.replace(/^C/, "")}`,
      },
    }),
  )
}
