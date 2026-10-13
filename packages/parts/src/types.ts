/**
 * Parts layer contracts — the highest-risk surface in the system.
 *
 * A part is only useful if its pinout and footprint are right. Both carry explicit
 * provenance and an explicit verification flag, because an unverified footprint is a
 * board that does not fit its parts.
 */

import { z } from "zod"

export const pinKindSchema = z.enum([
  "passive",
  "input",
  "output",
  "bidirectional",
  "power_in",
  "power_out",
  "ground",
  "open_drain",
  "open_collector",
  "tristate",
  "no_connect",
  "unspecified",
])
export type PinKind = z.infer<typeof pinKindSchema>

export const pinSchema = z.object({
  number: z.union([z.number().int().positive(), z.string()]),
  name: z.string(),
  kind: pinKindSchema,
  /** Semantic roles used for symbol side assignment and agent reasoning. */
  functions: z.array(z.string()).default([]),
  /** Names the agent or an import might use for the same pin: "VCC", "VDD", "V+". */
  altNames: z.array(z.string()).default([]),
})

export const footprintSchema = z.object({
  ipc7351Name: z.string().optional(),
  jedecPackage: z.string().optional(),
  /** A @tscircuit/footprinter string, e.g. "sot223" or "0603". */
  footprinterString: z.string().optional(),
  /** Reference into a KiCad .pretty library, e.g. "Package_TO_SOT_SMD:SOT-223-3". */
  kicadModRef: z.string().optional(),
  /** Pre-resolved pcb_* circuit-json elements, when neither of the above applies. */
  circuitJsonElements: z.array(z.unknown()).optional(),
  /**
   * "verified" means the pad geometry was checked against the datasheet or came from a
   * trusted library. Agent house rules prefer verified parts.
   */
  verification: z.enum(["verified", "unverified"]).default("unverified"),
})

export const symbolSchema = z.object({
  source: z.enum(["schematic-symbols", "kicad", "custom"]),
  /** Symbol name in the source library, e.g. "resistor_horz". */
  ref: z.string(),
  data: z.unknown().optional(),
})

export const spiceSchema = z.object({
  /** Inline .model or .subckt text, injected into the netlist at export. */
  modelText: z.string().optional(),
  modelUrl: z.string().url().optional(),
  /** Part pin number to SPICE node order, e.g. { "1": 0, "2": 1, "3": 2 }. */
  mapping: z.record(z.number().int().nonnegative()).default({}),
})

export const provenanceSchema = z.object({
  source: z.string(),
  fetchedAt: z.string(),
  sourceUrl: z.string().optional(),
})

export const partDefinitionSchema = z.object({
  id: z.string(),
  mpn: z.string().optional(),
  manufacturer: z.string().optional(),
  category: z.string(),
  description: z.string(),
  /** The circuit-json ftype this part maps onto, e.g. "simple_resistor". */
  ftype: z.string(),
  pins: z.array(pinSchema),
  symbol: symbolSchema,
  footprint: footprintSchema,
  /** Structured parameters with units — what range filtering searches over. */
  electrical: z.record(z.unknown()).default({}),
  spice: spiceSchema.optional(),
  datasheetUrl: z.string().optional(),
  cad3d: z.object({ format: z.enum(["step", "wrl", "obj"]), url: z.string() }).optional(),
  distributors: z
    .array(
      z.object({
        name: z.enum(["digikey", "mouser", "lcsc", "nexar"]),
        sku: z.string(),
        url: z.string().optional(),
      }),
    )
    .default([]),
  lifecycle: z.enum(["active", "nrnd", "obsolete", "unknown"]).default("unknown"),
  /** Licence of the symbol/footprint data, recorded per part and shown in the BOM. */
  license: z.string().default("unknown"),
  provenance: provenanceSchema,
  version: z.number().int().default(1),
})

export type PartDefinition = z.infer<typeof partDefinitionSchema>
export type Pin = z.infer<typeof pinSchema>
export type Footprint = z.infer<typeof footprintSchema>

export interface PartSummary {
  id: string
  mpn?: string
  manufacturer?: string
  description: string
  category: string
  package?: string
  footprintVerified: boolean
  source: string
}

export interface PartFilters {
  category?: string
  package?: string
  manufacturer?: string
  /** Parameter range filters, e.g. { voltage_out: { min: 3.2, max: 3.4 } }. */
  params?: Record<string, { min?: number; max?: number; eq?: string | number }>
  inStockOnly?: boolean
  limit?: number
}

/**
 * A federated parts source. `status()` is on the interface rather than inferred from a
 * thrown error so that a missing API key degrades to "skipped", never to a failed
 * search.
 */
export interface PartsSource {
  id: string
  label: string
  /** Lower numbers are consulted first when merging federated results. */
  priority: number
  status(): "ready" | "disabled"
  /** Why it is disabled, surfaced in the UI so a missing key is diagnosable. */
  disabledReason?(): string | undefined
  search(query: string, filters?: PartFilters): Promise<PartSummary[]>
  fetch(sku: string): Promise<PartDefinition | undefined>
  checkStock?(sku: string): Promise<{ quantity: number; currency?: string; price?: number }>
}

export interface PartsSourceRegistry {
  register(source: PartsSource): void
  get(id: string): PartsSource | undefined
  /** Only sources reporting "ready". */
  active(): PartsSource[]
  list(): PartsSource[]
}
