/**
 * DigiKey, through the Product Information API v4.
 *
 * DigiKey is a catalogue, not a CAD library: it knows parametrics, stock and price, and
 * has no footprint or symbol to give. That shapes what this source is for — finding the
 * right part number and knowing whether you can buy it — after which the footprint comes
 * from LCSC or KiCad.
 *
 * **Without credentials it reports `disabled` and returns nothing.** That is M7's
 * criterion and it is not a detail: a missing key must never turn a parts search into an
 * error, because most people will never set one and the rest of the catalogue still works.
 *
 * OAuth2 client credentials, token cached until shortly before expiry. No HTML scraping
 * anywhere (principle 9) — this is the documented API, and the sandbox host is the
 * default because a new DigiKey app is sandbox-only until approved.
 */

import { partDefinitionSchema } from "./types"
import type { PartDefinition, PartFilters, PartSummary, PartsSource } from "./types"

export interface DigiKeySourceOptions {
  clientId?: string
  clientSecret?: string
  baseUrl?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

interface DigiKeyProduct {
  ManufacturerProductNumber?: string
  Manufacturer?: { Name?: string }
  Description?: { ProductDescription?: string; DetailedDescription?: string }
  Category?: { Name?: string }
  QuantityAvailable?: number
  UnitPrice?: number
  ProductUrl?: string
  Parameters?: Array<{ ParameterText?: string; ValueText?: string }>
}

export class DigiKeySource implements PartsSource {
  readonly id = "digikey"
  readonly label = "DigiKey"
  readonly priority = 40

  private token?: { value: string; expiresAt: number }

  constructor(private readonly options: DigiKeySourceOptions = {}) {}

  private get clientId(): string | undefined {
    return this.options.clientId ?? process.env["DIGIKEY_CLIENT_ID"]
  }

  private get clientSecret(): string | undefined {
    return this.options.clientSecret ?? process.env["DIGIKEY_CLIENT_SECRET"]
  }

  private get baseUrl(): string {
    return (
      this.options.baseUrl ?? process.env["DIGIKEY_BASE_URL"] ?? "https://sandbox-api.digikey.com"
    )
  }

  status(): "ready" | "disabled" {
    return this.clientId && this.clientSecret ? "ready" : "disabled"
  }

  disabledReason(): string | undefined {
    if (this.status() === "ready") return undefined
    const missing = [
      !this.clientId ? "DIGIKEY_CLIENT_ID" : undefined,
      !this.clientSecret ? "DIGIKEY_CLIENT_SECRET" : undefined,
    ].filter(Boolean)
    return `${missing.join(" and ")} not set`
  }

  async search(query: string, filters?: PartFilters): Promise<PartSummary[]> {
    if (this.status() === "disabled") return []

    const body = await this.post("/products/v4/search/keyword", {
      Keywords: query,
      Limit: filters?.limit ?? 10,
      Offset: 0,
    })

    const products = (body as { Products?: DigiKeyProduct[] } | undefined)?.Products ?? []
    return products.map((product) => toSummary(product))
  }

  async fetch(sku: string): Promise<PartDefinition | undefined> {
    if (this.status() === "disabled") return undefined

    const mpn = sku.replace(/^digikey:/, "")
    const body = await this.get(`/products/v4/search/${encodeURIComponent(mpn)}/productdetails`)
    const product = (body as { Product?: DigiKeyProduct } | undefined)?.Product
    if (!product) return undefined

    return partDefinitionSchema.parse({
      id: `digikey:${mpn}`,
      ...(product.ManufacturerProductNumber ? { mpn: product.ManufacturerProductNumber } : {}),
      ...(product.Manufacturer?.Name ? { manufacturer: product.Manufacturer.Name } : {}),
      category: product.Category?.Name ?? "Other",
      description:
        product.Description?.DetailedDescription ?? product.Description?.ProductDescription ?? mpn,
      ftype: "simple_chip",
      // DigiKey has no pinout and no footprint. Saying so plainly is better than shipping
      // an empty pin list that looks like a part nobody wired up.
      pins: [],
      symbol: { source: "custom", ref: `digikey:${mpn}` },
      footprint: { verification: "unverified" },
      electrical: Object.fromEntries(
        (product.Parameters ?? [])
          .filter((p) => p.ParameterText && p.ValueText)
          .map((p) => [p.ParameterText!.toLowerCase().replace(/\s+/g, "_"), p.ValueText!]),
      ),
      distributors: [
        {
          name: "digikey" as const,
          sku: mpn,
          ...(product.ProductUrl ? { url: product.ProductUrl } : {}),
        },
      ],
      license: "DigiKey Product Information API — catalogue data, terms per DigiKey",
      provenance: {
        source: "digikey-api-v4",
        fetchedAt: new Date().toISOString(),
        ...(product.ProductUrl ? { sourceUrl: product.ProductUrl } : {}),
      },
    })
  }

  async checkStock(sku: string): Promise<{ quantity: number; currency?: string; price?: number }> {
    if (this.status() === "disabled") return { quantity: 0 }

    const mpn = sku.replace(/^digikey:/, "")
    const body = await this.get(`/products/v4/search/${encodeURIComponent(mpn)}/productdetails`)
    const product = (body as { Product?: DigiKeyProduct } | undefined)?.Product

    return {
      quantity: product?.QuantityAvailable ?? 0,
      currency: "USD",
      ...(product?.UnitPrice !== undefined ? { price: product.UnitPrice } : {}),
    }
  }

  /**
   * An OAuth2 token, cached.
   *
   * Refreshed a minute early: a token that expires between the check and the call fails
   * a search for no reason the user could understand.
   */
  private async accessToken(): Promise<string | undefined> {
    if (this.token && this.token.expiresAt > Date.now()) return this.token.value

    const response = await this.raw(`${this.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.clientId ?? "",
        client_secret: this.clientSecret ?? "",
        grant_type: "client_credentials",
      }).toString(),
    })

    const body = (await response?.json().catch(() => undefined)) as
      { access_token?: string; expires_in?: number } | undefined
    if (!body?.access_token) return undefined

    this.token = {
      value: body.access_token,
      expiresAt: Date.now() + ((body.expires_in ?? 600) - 60) * 1000,
    }
    return this.token.value
  }

  private async get(path: string): Promise<unknown> {
    const token = await this.accessToken()
    if (!token) return undefined
    const response = await this.raw(`${this.baseUrl}${path}`, { headers: this.headers(token) })
    return response?.ok ? response.json() : undefined
  }

  private async post(path: string, payload: unknown): Promise<unknown> {
    const token = await this.accessToken()
    if (!token) return undefined
    const response = await this.raw(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { ...this.headers(token), "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
    return response?.ok ? response.json() : undefined
  }

  private headers(token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      "X-DIGIKEY-Client-Id": this.clientId ?? "",
      "X-DIGIKEY-Locale-Site": "US",
      "X-DIGIKEY-Locale-Currency": "USD",
    }
  }

  /** Never throws: a distributor being down must not fail a federated search. */
  private async raw(url: string, init: RequestInit): Promise<Response | undefined> {
    const impl = this.options.fetchImpl ?? fetch
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 12_000)
    try {
      return await impl(url, { ...init, signal: controller.signal })
    } catch {
      return undefined
    } finally {
      clearTimeout(timer)
    }
  }
}

const toSummary = (product: DigiKeyProduct): PartSummary => ({
  id: `digikey:${product.ManufacturerProductNumber ?? "unknown"}`,
  ...(product.ManufacturerProductNumber ? { mpn: product.ManufacturerProductNumber } : {}),
  ...(product.Manufacturer?.Name ? { manufacturer: product.Manufacturer.Name } : {}),
  description:
    product.Description?.ProductDescription ?? product.ManufacturerProductNumber ?? "DigiKey part",
  category: product.Category?.Name ?? "Other",
  // DigiKey ships no footprint, so nothing here has been verified. Claiming otherwise
  // would defeat the flag's only purpose.
  footprintVerified: false,
  source: "digikey",
})
