/**
 * The T2 federated sources.
 *
 * Every test here is offline. The network calls are injected, and the one test that does
 * reach LCSC is opt-in behind `SYNTRIX_LIVE_PARTS=1` — a suite that fails when GitHub
 * Actions has no route to jlcsearch is a suite people learn to ignore.
 *
 * The LCSC fixture is a recording of a real `fetchPartCircuitJson('C6186')` response,
 * trimmed to the elements that matter. Recording it rather than inventing it is the
 * point: it is what proves the mapping handles what the API actually sends.
 */

import { describe, expect, it } from "vitest"
import { buildPartDefinition, LcscSource } from "./lcsc-source"
import { KicadLibrarySource } from "./kicad-source"
import { DigiKeySource } from "./digikey-source"
import { createRegistry } from "./registry"

/** Recorded from LCSC C6186 (AMS1117-3.3) on 2026-09-15. */
const AMS1117_ELEMENTS = [
  {
    type: "source_component",
    source_component_id: "source_component_0",
    name: "U1",
    ftype: "simple_chip",
  },
  {
    type: "source_port",
    source_port_id: "sp0",
    source_component_id: "source_component_0",
    name: "GND",
    pin_number: 1,
    port_hints: ["GND", "1", "pin1"],
  },
  {
    type: "source_port",
    source_port_id: "sp1",
    source_component_id: "source_component_0",
    name: "VOUT",
    pin_number: 2,
    port_hints: ["VOUT", "2", "pin2"],
  },
  {
    type: "source_port",
    source_port_id: "sp2",
    source_component_id: "source_component_0",
    name: "VIN",
    pin_number: 3,
    port_hints: ["VIN", "3", "pin3"],
  },
  {
    type: "source_port",
    source_port_id: "sp3",
    source_component_id: "source_component_0",
    name: "VOUT",
    pin_number: 4,
    port_hints: ["VOUT", "4", "pin4"],
  },
  { type: "pcb_smtpad", pcb_smtpad_id: "pad0", shape: "rect", x: -2.3, y: -2.3 },
  { type: "pcb_smtpad", pcb_smtpad_id: "pad1", shape: "rect", x: 0, y: -2.3 },
  { type: "pcb_smtpad", pcb_smtpad_id: "pad2", shape: "rect", x: 2.3, y: -2.3 },
  { type: "pcb_smtpad", pcb_smtpad_id: "pad3", shape: "rect", x: 0, y: 2.3 },
  { type: "pcb_silkscreen_path", pcb_silkscreen_path_id: "silk0", route: [] },
  { type: "pcb_courtyard_outline", pcb_courtyard_outline_id: "cy0" },
  {
    type: "cad_component",
    cad_component_id: "cad0",
    model_obj_url: "https://modules.easyeda.com/3dmodel/e80246a9471445bfb635be848806a22e",
    model_step_url: "https://modules.easyeda.com/qAxj/e80246a9471445bfb635be848806a22e",
  },
]

const AMS1117_ROW = {
  lcsc: 6186,
  mfr: "AMS1117-3.3",
  package: "SOT-223",
  description: "1A Positive Fixed 3.3V Voltage Regulator SOT-223",
  is_basic: true,
  stock: 96_000,
}

describe("LCSC part mapping", () => {
  it("yields a symbol, a footprint and a 3D model — M7's criterion", () => {
    const result = buildPartDefinition("C6186", AMS1117_ELEMENTS, AMS1117_ROW)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const part = result.value

    // Symbol: the component and a pin per port, addressable by the datasheet name.
    expect(part.pins).toHaveLength(4)
    expect(part.pins.map((p) => p.name)).toContain("VIN")
    expect(part.pins.find((p) => p.name === "VIN")?.altNames).toContain("3")

    // Footprint: real pads from EasyEDA's package drawing, not a guess from a name.
    expect(part.footprint.verification).toBe("verified")
    expect(part.footprint.circuitJsonElements?.length).toBeGreaterThanOrEqual(4)

    // 3D: a STEP model, which is what a mechanical review needs.
    expect(part.cad3d?.format).toBe("step")
    expect(part.cad3d?.url).toMatch(/^https:/)
  })

  it("records licence and provenance per part", () => {
    const result = buildPartDefinition("C6186", AMS1117_ELEMENTS, AMS1117_ROW)
    if (!result.ok) throw new Error("mapping failed")

    // EasyEDA's library terms are not an open licence, and a BOM that does not say so is
    // a problem waiting for someone else (principle 9).
    expect(result.value.license).toMatch(/easyeda/i)
    expect(result.value.provenance?.sourceUrl).toContain("jlcpcb.com")
    expect(result.value.distributors?.[0]).toMatchObject({ name: "lcsc", sku: "C6186" })
  })

  it("marks the footprint unverified when the part came back with no pads", () => {
    const withoutPads = AMS1117_ELEMENTS.filter((e) => e.type !== "pcb_smtpad")
    const result = buildPartDefinition("C6186", withoutPads, AMS1117_ROW)

    if (!result.ok) throw new Error("mapping failed")
    expect(result.value.footprint.verification).toBe("unverified")
  })

  it("fails with a usable message when there is no component at all", () => {
    const result = buildPartDefinition("C99999999", [])

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error[0]?.code).toBe("PART_NOT_FOUND")
      expect(result.error[0]?.hint).toBeTruthy()
    }
  })
})

describe("LcscSource", () => {
  /** jlcsearch's real response shape, as returned by the live API. */
  const searchResponse = { components: [AMS1117_ROW] }

  const fakeFetch = (async () =>
    new Response(JSON.stringify(searchResponse), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch

  it("searches and summarises", async () => {
    const source = new LcscSource({ fetchImpl: fakeFetch })
    const results = await source.search("AMS1117")

    expect(results[0]).toMatchObject({
      id: "lcsc:C6186",
      mpn: "AMS1117-3.3",
      package: "SOT-223",
      footprintVerified: true,
      source: "lcsc",
    })
  })

  it("fetches a full part without touching the network in tests", async () => {
    const source = new LcscSource({
      fetchImpl: fakeFetch,
      fetchCircuitJson: async () => AMS1117_ELEMENTS,
    })

    const part = await source.fetch("C6186")
    expect(part?.cad3d).toBeDefined()
    expect(part?.pins).toHaveLength(4)
  })

  it("normalises however the id was written", async () => {
    const seen: string[] = []
    const source = new LcscSource({
      fetchImpl: fakeFetch,
      fetchCircuitJson: async (id) => {
        seen.push(id)
        return AMS1117_ELEMENTS
      },
    })

    for (const written of ["C6186", "6186", "lcsc:C6186"]) await source.fetch(written)
    expect(seen).toEqual(["C6186", "C6186", "C6186"])
  })

  it("returns nothing rather than throwing when the API is unreachable", async () => {
    const source = new LcscSource({
      fetchImpl: (async () => {
        throw new Error("ENOTFOUND")
      }) as unknown as typeof fetch,
    })

    // A dead distributor must not break a federated search.
    await expect(source.search("anything")).resolves.toEqual([])
  })

  it("can be turned off", async () => {
    const source = new LcscSource({ enabled: false })
    expect(source.status()).toBe("disabled")
    expect(await source.search("AMS1117")).toEqual([])
    expect(await source.fetch("C6186")).toBeUndefined()
  })
})

describe("DigiKeySource", () => {
  it("reports disabled without credentials, and never errors — M7's criterion", async () => {
    const source = new DigiKeySource({ clientId: "", clientSecret: "" })

    expect(source.status()).toBe("disabled")
    expect(source.disabledReason()).toMatch(/DIGIKEY_CLIENT_ID/)
    // Most people will never set a key, and the rest of the catalogue has to keep working.
    await expect(source.search("LM317")).resolves.toEqual([])
    await expect(source.fetch("LM317")).resolves.toBeUndefined()
    await expect(source.checkStock("LM317")).resolves.toEqual({ quantity: 0 })
  })

  it("is ready with credentials", () => {
    expect(new DigiKeySource({ clientId: "id", clientSecret: "secret" }).status()).toBe("ready")
  })

  it("authenticates, then searches with the token", async () => {
    const calls: string[] = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push(String(url))
      if (String(url).includes("/oauth2/token")) {
        return new Response(JSON.stringify({ access_token: "tok", expires_in: 600 }), {
          status: 200,
        })
      }
      // The token has to be presented on the call itself, not only obtained.
      expect((init?.headers as Record<string, string>)["Authorization"]).toBe("Bearer tok")
      return new Response(
        JSON.stringify({
          Products: [
            {
              ManufacturerProductNumber: "LM317T",
              Manufacturer: { Name: "TI" },
              Description: { ProductDescription: "Adjustable regulator" },
              Category: { Name: "PMIC" },
            },
          ],
        }),
        { status: 200 },
      )
    }) as unknown as typeof fetch

    const source = new DigiKeySource({ clientId: "id", clientSecret: "secret", fetchImpl })
    const results = await source.search("LM317")

    expect(calls[0]).toContain("/v1/oauth2/token")
    expect(results[0]).toMatchObject({ mpn: "LM317T", manufacturer: "TI", source: "digikey" })
    // DigiKey ships no footprint, so nothing from it is verified.
    expect(results[0]?.footprintVerified).toBe(false)
  })

  it("reuses the token rather than authenticating per call", async () => {
    let tokenCalls = 0
    const fetchImpl = (async (url: string) => {
      if (String(url).includes("/oauth2/token")) {
        tokenCalls += 1
        return new Response(JSON.stringify({ access_token: "tok", expires_in: 600 }), {
          status: 200,
        })
      }
      return new Response(JSON.stringify({ Products: [] }), { status: 200 })
    }) as unknown as typeof fetch

    const source = new DigiKeySource({ clientId: "id", clientSecret: "secret", fetchImpl })
    await source.search("a")
    await source.search("b")

    expect(tokenCalls).toBe(1)
  })
})

describe("KicadLibrarySource", () => {
  it("reports disabled with no library checked out, and says how to get one", async () => {
    const source = new KicadLibrarySource({ footprintsPath: "/definitely/not/here" })

    expect(source.status()).toBe("disabled")
    expect(source.disabledReason()).toMatch(/make kicad-libs/)
    await expect(source.search("SOT-223")).resolves.toEqual([])
  })
})

describe("federated search with T2 sources", () => {
  it("skips disabled sources instead of failing", async () => {
    const registry = createRegistry()
    registry.register(new DigiKeySource({ clientId: "", clientSecret: "" }))
    registry.register(new KicadLibrarySource({ footprintsPath: "/nope" }))
    registry.register(new LcscSource({ enabled: false }))

    // Every source is unavailable, and a search still returns — empty, not broken.
    expect(registry.active()).toHaveLength(0)
    expect(registry.list()).toHaveLength(3)
  })
})
