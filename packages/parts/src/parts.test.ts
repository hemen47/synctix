import { beforeEach, describe, expect, it } from "vitest"
import { createSequentialIdFactory, setIdFactory } from "@syntrix/shared"
import { apply, createDesign, buildIndex, resolvePort, runErc } from "@syntrix/core"
import { T0_PARTS, getT0Part } from "./t0-catalog"
import { searchParts, tokenize, facetCounts, toSummary } from "./search"
import { KNOWN_FOOTPRINTS, resolveFootprint, verifyPinMapping } from "./footprint"
import {
  createDefaultRegistry,
  createRegistry,
  federatedSearch,
  getPart,
  t0Resolver,
  t0Source,
} from "./registry"
import { partDefinitionSchema } from "./types"
import type { PartsSource } from "./types"

beforeEach(() => setIdFactory(createSequentialIdFactory()))

describe("T0 catalog integrity", () => {
  it("every part conforms to the PartDefinition schema", () => {
    for (const part of T0_PARTS) {
      const result = partDefinitionSchema.safeParse(part)
      if (!result.success) {
        throw new Error(
          `${part.id} is invalid: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        )
      }
    }
    expect(T0_PARTS.length).toBeGreaterThanOrEqual(30)
  })

  it("has unique ids", () => {
    const ids = T0_PARTS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("gives every pin a number, a name and at least one alias", () => {
    for (const part of T0_PARTS) {
      expect(part.pins.length, `${part.id} has no pins`).toBeGreaterThan(0)
      for (const pin of part.pins) {
        expect(pin.name, `${part.id} pin ${pin.number} has no name`).toBeTruthy()
        // Aliases are what become port_hints, so a pin without them is only addressable
        // by number.
        expect(pin.altNames.length, `${part.id} pin ${pin.number} has no aliases`).toBeGreaterThan(
          0,
        )
      }
    }
  })

  it("records licence and provenance on every part", () => {
    for (const part of T0_PARTS) {
      expect(part.license).not.toBe("unknown")
      expect(part.provenance.source).toBeTruthy()
    }
  })

  it("resolves parts by id and by MPN, case-insensitively", () => {
    expect(getT0Part("t0:ams1117-3.3")?.mpn).toBe("AMS1117-3.3")
    expect(getT0Part("AMS1117-3.3")?.id).toBe("t0:ams1117-3.3")
    expect(getT0Part("ams1117-3.3")?.id).toBe("t0:ams1117-3.3")
    expect(getT0Part("nonexistent")).toBeUndefined()
  })
})

describe("footprint resolution", () => {
  it("resolves a footprinter string to pcb elements with the right pad count", () => {
    for (const [spec, expectedPads] of Object.entries(KNOWN_FOOTPRINTS)) {
      const result = resolveFootprint({ footprinterString: spec, verification: "unverified" })
      if (!result.ok) {
        throw new Error(`${spec} failed to resolve: ${result.error[0]?.message}`)
      }
      expect(result.value.padCount, `${spec} pad count`).toBe(expectedPads)
      // Footprinter output is IPC-derived, so it is the one source treated as verified.
      expect(result.value.verification).toBe("verified")
      expect(result.value.resolvedBy).toBe("footprinter")
    }
  })

  it("fills in the empty ids footprinter leaves behind", () => {
    const result = resolveFootprint({ footprinterString: "0603", verification: "unverified" })
    expect(result.ok).toBe(true)
    if (result.ok) {
      for (const element of result.value.elements) {
        const record = element as Record<string, unknown>
        const idKey = `${record["type"]}_id`
        expect(record[idKey], `${record["type"]} has no id`).toBeTruthy()
      }
    }
  })

  it("exposes pad hints so pads can be mapped back to pins", () => {
    const result = resolveFootprint({ footprinterString: "sot223", verification: "unverified" })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.padHints).toHaveLength(4)
      expect(result.value.padHints.flat()).toContain("1")
    }
  })

  it("reports an unparseable footprinter string with a usable hint", () => {
    const result = resolveFootprint({
      footprinterString: "definitely_not_a_package",
      verification: "unverified",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error[0]?.code).toBe("FOOTPRINT_UNRESOLVED")
      expect(result.error[0]?.hint).toContain("0603")
    }
  })

  it("does not claim verification for pre-supplied geometry it cannot check", () => {
    const result = resolveFootprint({
      circuitJsonElements: [
        {
          type: "pcb_smtpad",
          pcb_smtpad_id: "",
          x: 0,
          y: 0,
          shape: "rect",
          width: 1,
          height: 1,
          layer: "top",
          port_hints: ["1"],
        },
      ],
      verification: "unverified",
    })

    expect(result.ok).toBe(true)
    // Trusted exactly as far as the definition claims — no more.
    if (result.ok) expect(result.value.verification).toBe("unverified")
  })

  it("says KiCad footprints are not available until M8", () => {
    const result = resolveFootprint({
      kicadModRef: "Package_TO_SOT_SMD:SOT-223-3",
      verification: "unverified",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error[0]?.hint).toContain("M8")
  })

  it("reports a part with no footprint information at all", () => {
    const result = resolveFootprint({ verification: "unverified" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error[0]?.hint).toContain("footprinterString")
  })
})

describe("verifyPinMapping", () => {
  it("accepts a part whose pin count matches its footprint", () => {
    const footprint = resolveFootprint({ footprinterString: "sot223", verification: "unverified" })
    expect(footprint.ok).toBe(true)
    if (footprint.ok) expect(verifyPinMapping(footprint.value, [1, 2, 3, 4]).ok).toBe(true)
  })

  it("rejects a pin count that disagrees with the footprint", () => {
    // A 3-pin part on an 8-pad footprint reaches the board house if nobody checks.
    const footprint = resolveFootprint({ footprinterString: "soic8", verification: "unverified" })
    expect(footprint.ok).toBe(true)
    if (footprint.ok) {
      const result = verifyPinMapping(footprint.value, [1, 2, 3])
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error[0]?.code).toBe("PIN_MAP_INCOMPLETE")
        expect(result.error[0]?.message).toContain("3 pin(s)")
        expect(result.error[0]?.message).toContain("8 pad(s)")
      }
    }
  })

  it("rejects a pin that no pad is labelled for", () => {
    const footprint = resolveFootprint({ footprinterString: "sot223", verification: "unverified" })
    expect(footprint.ok).toBe(true)
    if (footprint.ok) {
      const result = verifyPinMapping(footprint.value, [1, 2, 3, 99])
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error[0]?.message).toContain("99")
    }
  })
})

describe("every T0 part with a footprint resolves and matches its pin count", () => {
  it("holds for the whole catalog", () => {
    const problems: string[] = []

    for (const part of T0_PARTS) {
      if (!part.footprint.footprinterString) continue

      const resolved = resolveFootprint(part.footprint)
      if (!resolved.ok) {
        problems.push(`${part.id}: ${resolved.error[0]?.message}`)
        continue
      }

      const mapping = verifyPinMapping(
        resolved.value,
        part.pins.map((p) => p.number),
      )
      if (!mapping.ok) problems.push(`${part.id}: ${mapping.error[0]?.message}`)
    }

    // Reported all at once rather than failing on the first, so a catalogue edit shows
    // every consequence in one run.
    expect(problems, problems.join("\n")).toEqual([])
  })
})

describe("search", () => {
  it("tokenizes an engineer's query", () => {
    expect(tokenize("3.3V LDO SOT-223")).toEqual(["3.3v", "ldo", "sot-223"])
    expect(tokenize("  10k   0603, resistor ")).toEqual(["10k", "0603", "resistor"])
  })

  /** M2's exit criterion. */
  it('finds AMS1117 with a verified footprint for "3.3V LDO SOT-223"', () => {
    const results = searchParts(T0_PARTS, "3.3V LDO SOT-223")

    expect(results.length).toBeGreaterThan(0)
    const top = results[0]!
    expect(top.part.mpn).toBe("AMS1117-3.3")
    expect(top.part.footprint.verification).toBe("verified")
    expect(top.part.footprint.jedecPackage).toBe("SOT-223")
    expect(top.part.electrical["voltage_out_v"]).toBe(3.3)

    // And the footprint it claims is verified must actually resolve.
    const footprint = resolveFootprint(top.part.footprint)
    expect(footprint.ok).toBe(true)
    // Three leads plus the thermal tab: the part declares all four, so the pin count
    // and the pad count agree.
    if (footprint.ok) expect(footprint.value.padCount).toBe(4)
  })

  it("finds a part by exact MPN", () => {
    expect(searchParts(T0_PARTS, "NE555")[0]?.part.mpn).toBe("NE555")
    expect(searchParts(T0_PARTS, "LM358")[0]?.part.mpn).toBe("LM358")
  })

  it("understands abbreviations", () => {
    expect(searchParts(T0_PARTS, "opamp").map((r) => r.part.id)).toContain("t0:opamp")
    expect(searchParts(T0_PARTS, "mcu").map((r) => r.part.category)).toContain("Microcontroller")
    expect(searchParts(T0_PARTS, "xtal").map((r) => r.part.id)).toContain("t0:crystal")
  })

  it("matches a package written with or without its hyphen", () => {
    const withHyphen = searchParts(T0_PARTS, "SOT-223").map((r) => r.part.id)
    const without = searchParts(T0_PARTS, "sot223").map((r) => r.part.id)
    expect(withHyphen).toContain("t0:ams1117-3.3")
    expect(without).toContain("t0:ams1117-3.3")
  })

  it("ranks a part matching every term above one matching a single term well", () => {
    const results = searchParts(T0_PARTS, "3.3V LDO SOT-223")
    const ams = results.findIndex((r) => r.part.id === "t0:ams1117-3.3")
    const lm7805 = results.findIndex((r) => r.part.id === "t0:lm7805")
    expect(ams).toBeGreaterThanOrEqual(0)
    // The 5V TO-220 regulator matches "regulator" but neither the voltage nor the
    // package, so it must not win.
    if (lm7805 >= 0) expect(ams).toBeLessThan(lm7805)
  })

  it("filters by package", () => {
    const results = searchParts(T0_PARTS, "regulator", { package: "SOT-223" })
    expect(results.length).toBeGreaterThan(0)
    for (const r of results) {
      expect(r.part.footprint.jedecPackage).toBe("SOT-223")
    }
  })

  it("filters by a numeric parameter range", () => {
    const results = searchParts(T0_PARTS, "regulator", {
      params: { voltage_out_v: { min: 3.0, max: 3.5 } },
    })
    expect(results.length).toBeGreaterThan(0)
    for (const r of results) {
      expect(r.part.electrical["voltage_out_v"]).toBeGreaterThanOrEqual(3.0)
      expect(r.part.electrical["voltage_out_v"]).toBeLessThanOrEqual(3.5)
    }
  })

  it("excludes parts that do not publish a filtered parameter", () => {
    // A maybe is not a match when the user asked for a range.
    const results = searchParts(T0_PARTS, "", { params: { voltage_out_v: { min: 0 } } })
    for (const r of results) expect(typeof r.part.electrical["voltage_out_v"]).toBe("number")
  })

  it("treats an empty query with filters as a browse", () => {
    const results = searchParts(T0_PARTS, "", { category: "Capacitor" })
    expect(results.length).toBeGreaterThan(0)
    for (const r of results) expect(r.part.category).toBe("Capacitor")
  })

  it("returns nothing for a query that matches nothing", () => {
    expect(searchParts(T0_PARTS, "zzzz qqqq wwww")).toHaveLength(0)
  })

  it("honours the result limit", () => {
    expect(searchParts(T0_PARTS, "", { limit: 3 })).toHaveLength(3)
  })

  it("produces facet counts for the palette", () => {
    const facets = facetCounts(T0_PARTS)
    expect(facets.categories["Voltage Regulator"]).toBeGreaterThanOrEqual(3)
    expect(Object.keys(facets.packages).length).toBeGreaterThan(0)
  })

  it("summarises a part for the UI", () => {
    const summary = toSummary(getT0Part("t0:ams1117-3.3")!)
    expect(summary).toMatchObject({
      mpn: "AMS1117-3.3",
      package: "SOT-223",
      footprintVerified: true,
      source: "t0",
    })
  })
})

describe("registry and federated search", () => {
  it("searches T0 through the default registry", async () => {
    const result = await federatedSearch(createDefaultRegistry(), "3.3V LDO SOT-223")
    expect(result.results[0]?.mpn).toBe("AMS1117-3.3")
    expect(result.sources).toEqual([{ id: "t0", status: "ready", count: expect.any(Number) }])
  })

  it("skips a disabled source instead of failing", async () => {
    const registry = createDefaultRegistry()
    const disabled: PartsSource = {
      id: "digikey",
      label: "DigiKey",
      priority: 10,
      status: () => "disabled",
      disabledReason: () => "DIGIKEY_CLIENT_ID is not set",
      search: async () => {
        throw new Error("should never be called")
      },
      fetch: async () => undefined,
    }
    registry.register(disabled)

    const result = await federatedSearch(registry, "NE555")

    // A missing API key must never break a search that T0 could answer.
    expect(result.results.length).toBeGreaterThan(0)
    expect(result.sources.find((s) => s.id === "digikey")).toMatchObject({
      status: "disabled",
      detail: "DIGIKEY_CLIENT_ID is not set",
    })
  })

  it("survives a source that throws, and still returns the others' results", async () => {
    const registry = createDefaultRegistry()
    registry.register({
      id: "flaky",
      label: "Flaky",
      priority: 5,
      status: () => "ready",
      search: async () => {
        throw new Error("upstream 503")
      },
      fetch: async () => undefined,
    })

    const result = await federatedSearch(registry, "NE555")
    expect(result.results.length).toBeGreaterThan(0)
    expect(result.sources.find((s) => s.id === "flaky")).toMatchObject({
      status: "failed",
      detail: "upstream 503",
    })
  })

  it("lets a higher-priority source win a duplicate MPN", async () => {
    const registry = createRegistry()
    registry.register(t0Source) // priority 0
    registry.register({
      id: "other",
      label: "Other",
      priority: 99,
      status: () => "ready",
      search: async () => [
        {
          id: "other:555",
          mpn: "NE555",
          description: "a different NE555",
          category: "Timer",
          footprintVerified: false,
          source: "other",
        },
      ],
      fetch: async () => undefined,
    })

    const result = await federatedSearch(registry, "NE555")
    const ne555s = result.results.filter((r) => r.mpn === "NE555")
    expect(ne555s).toHaveLength(1)
    expect(ne555s[0]?.source).toBe("t0")
  })

  it("names the disabled sources when a part is not found", async () => {
    const registry = createDefaultRegistry()
    registry.register({
      id: "mouser",
      label: "Mouser",
      priority: 10,
      status: () => "disabled",
      search: async () => [],
      fetch: async () => undefined,
    })

    const result = await getPart(registry, "SOME-EXOTIC-PART")
    expect(result.ok).toBe(false)
    // The hint tells the user why the search was narrow and how to widen it.
    if (!result.ok) expect(result.error[0]?.hint).toContain("mouser")
  })

  it("fetches a part through the registry", async () => {
    const result = await getPart(createDefaultRegistry(), "NE555")
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.mpn).toBe("NE555")
  })
})

describe("the bridge into core", () => {
  it("adds a catalog part to a design with its real pinout", () => {
    const result = apply(
      createDesign("d"),
      { type: "add_component", partRef: "t0:ams1117-3.3", name: "U1", props: {} },
      { resolvePart: t0Resolver },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const view = buildIndex(result.value.circuit)
    // Three leads plus the SOT-223 thermal tab.
    expect(
      view.portsByComponent.get(view.componentsByName.get("U1")!.source_component_id),
    ).toHaveLength(4)
    // Provenance survives into the sidecar.
    expect(Object.values(result.value.meta).some((m) => m.partRef === "t0:ams1117-3.3")).toBe(true)
  })

  it("makes pins addressable by their datasheet names", () => {
    const result = apply(
      createDesign("d"),
      { type: "add_component", partRef: "t0:ams1117-3.3", name: "U1", props: {} },
      { resolvePart: t0Resolver },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const view = buildIndex(result.value.circuit)
    // This is the whole point of port_hints: the agent writes the name on the datasheet.
    expect(resolvePort(view, { component: "U1", pin: "VOUT" })?.pin_number).toBe(2)
    expect(resolvePort(view, { component: "U1", pin: "VIN" })?.pin_number).toBe(3)
    expect(resolvePort(view, { component: "U1", pin: "GND" })?.pin_number).toBe(1)
    expect(resolvePort(view, { component: "U1", pin: 2 })?.name).toBe("VOUT")
  })

  it("does not mark a named pinout as interchangeable", () => {
    const spec = t0Resolver("t0:ams1117-3.3")
    expect(spec?.spec.pinsInterchangeable).toBe(false)
    // Two-terminal passives are.
    expect(t0Resolver("t0:resistor")?.spec.pinsInterchangeable).toBe(true)
  })

  it("builds an AMS1117 regulator that passes ERC", () => {
    const build = apply(
      createDesign("reg"),
      {
        type: "batch",
        atomic: true,
        ops: [
          { type: "add_component", partRef: "t0:ams1117-3.3", name: "U1", props: {} },
          {
            type: "add_component",
            partRef: "t0:capacitor",
            name: "C1",
            props: { capacitance: "10uF" },
          },
          {
            type: "add_component",
            partRef: "t0:capacitor",
            name: "C2",
            props: { capacitance: "22uF" },
          },
          { type: "create_net", name: "VIN", isPower: true, isGround: false },
          { type: "create_net", name: "+3V3", isPower: true, isGround: false },
          { type: "create_net", name: "GND", isPower: false, isGround: true },
          { type: "connect", a: { component: "U1", pin: "VIN" }, b: { net: "VIN" } },
          { type: "connect", a: { component: "U1", pin: "VOUT" }, b: { net: "+3V3" } },
          { type: "connect", a: { component: "U1", pin: "GND" }, b: { net: "GND" } },
          { type: "connect", a: { component: "C1", pin: 1 }, b: { net: "VIN" } },
          { type: "connect", a: { component: "C1", pin: 2 }, b: { net: "GND" } },
          { type: "connect", a: { component: "C2", pin: 1 }, b: { net: "+3V3" } },
          { type: "connect", a: { component: "C2", pin: 2 }, b: { net: "GND" } },
        ],
      },
      { resolvePart: t0Resolver },
    )

    expect(build.ok).toBe(true)
    if (!build.ok) return

    const report = runErc(build.value)
    expect(report.pass, report.violations.map((v) => `${v.rule}: ${v.message}`).join("\n")).toBe(
      true,
    )
  })

  it("returns undefined for an unknown part reference", () => {
    expect(t0Resolver("t0:does-not-exist")).toBeUndefined()
  })
})
