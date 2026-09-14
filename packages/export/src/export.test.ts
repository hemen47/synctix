/**
 * Exporters.
 *
 * The tscircuit-backed ones are checked for the thing an adapter can actually get wrong:
 * that it calls the real API correctly and produces a non-empty artifact of the right
 * shape. Asserting on the *content* of KiCad or Gerber output would be testing
 * tscircuit's exporters, which are not ours to test.
 *
 * The LTspice exporter is ours, so it is held to a much higher standard: its output is
 * parsed back and interrogated.
 */

import { beforeEach, describe, expect, it } from "vitest"
import { createSequentialIdFactory, setIdFactory } from "@syntrix/shared"
import { applyAll, createDesign, type Design, type Operation } from "@syntrix/core"
import { elkLayoutStrategy } from "@syntrix/layout"
import { t0Resolver } from "@syntrix/parts"
import { createExporterRegistry } from "./registry"
import { ltspiceExporter, writeLtspiceAsc } from "./ltspice"
import { AscParseError, componentsByName, netsFromFlags, parseAsc } from "./ltspice-parser"
import {
  bomExporter,
  kicadExporter,
  pnpExporter,
  spiceExporter,
  svgExporter,
  tscircuitExporters,
} from "./tscircuit-exporters"

const RC_LOWPASS: Operation[] = [
  { type: "add_component", ftype: "simple_resistor", name: "R1", props: { resistance: "10k" } },
  { type: "add_component", ftype: "simple_capacitor", name: "C1", props: { capacitance: "100nF" } },
  { type: "add_component", ftype: "simple_ground", name: "GND1", props: {} },
  { type: "create_net", name: "VOUT", isPower: false, isGround: false },
  { type: "create_net", name: "GND", isPower: false, isGround: true },
  { type: "connect", a: { component: "R1", pin: 2 }, b: { net: "VOUT" } },
  { type: "connect", a: { component: "C1", pin: 1 }, b: { net: "VOUT" } },
  { type: "connect", a: { component: "C1", pin: 2 }, b: { net: "GND" } },
  { type: "connect", a: { component: "GND1", pin: 1 }, b: { net: "GND" } },
]

const build = (ops: Operation[] = RC_LOWPASS): Design => {
  const result = applyAll(createDesign("rc_lowpass"), ops, { resolvePart: t0Resolver })
  if (!result.ok) throw new Error(result.error.map((e) => e.message).join(" | "))
  return result.value
}

/** With a schematic layer, which is what a real export has. */
const laidOut = async (design = build()): Promise<Design> => {
  const layout = await elkLayoutStrategy.layout(design)
  if (!layout.ok) throw new Error("layout failed")
  return { ...design, circuit: [...design.circuit, ...layout.value.elements] }
}

beforeEach(() => setIdFactory(createSequentialIdFactory()))

describe("registry", () => {
  it("registers, finds and lists", () => {
    const registry = createExporterRegistry(tscircuitExporters)
    registry.register(ltspiceExporter)

    expect(registry.get("ltspice-asc")?.label).toBe("LTspice schematic (.asc)")
    expect(registry.list().length).toBe(tscircuitExporters.length + 1)
    expect(registry.get("nope")).toBeUndefined()
  })

  it("replaces an exporter registered under the same id", () => {
    const registry = createExporterRegistry([spiceExporter])
    registry.register({ ...spiceExporter, label: "Replaced" })
    expect(registry.list()).toHaveLength(1)
    expect(registry.get("spice")?.label).toBe("Replaced")
  })
})

describe("tscircuit-backed exporters", () => {
  it("SPICE: netlists the design", async () => {
    const result = await spiceExporter.export(build())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const netlist = result.value[0]!.text!
    // circuitJsonToSpice returns an object; the string comes from a second call. If that
    // were missed, this would be "[object Object]".
    expect(netlist).toMatch(/^\*|\.end/im)
    expect(netlist).not.toContain("[object Object]")
  })

  it("BOM: lists every component, not only the sourced ones", async () => {
    // circuit-json-to-bom-csv emits rows only for components carrying a distributor SKU,
    // so an unsourced design produces an empty string from it — verified, not assumed.
    // An engineer needs the parts list long before anyone has chosen a supplier, so this
    // exporter writes that part itself and merges the supplier columns in when they exist.
    const result = await bomExporter.export(build())

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const rows = result.value[0]!.text!.trim().split("\n")
    expect(result.value[0]!.filename).toMatch(/-bom\.csv$/)
    expect(rows[0]).toContain("Designator")
    expect(rows.slice(1).map((row) => row.split(",")[0])).toEqual(["R1", "C1", "GND1"])

    // The value as the author wrote it, and whether anyone checked the footprint.
    expect(rows[1]).toContain("10k")
    expect(rows[0]).toContain("FootprintVerified")
  })

  it("BOM: quotes a value that would otherwise break the CSV", async () => {
    const design = build([
      { type: "add_component", ftype: "simple_resistor", name: "R1", props: { resistance: "10k" } },
      { type: "rename", component: "R1", name: "R,1" },
    ])
    const result = await bomExporter.export(design)

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value[0]!.text).toContain('"R,1"')
  })

  it("pick and place: produces a CSV", async () => {
    const result = await pnpExporter.export(await laidOut())
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value[0]!.mime).toBe("text/csv")
  })

  it("KiCad: writes a schematic even when there is no board", async () => {
    const result = await kicadExporter.export(await laidOut())

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const sch = result.value.find((a) => a.filename.endsWith(".kicad_sch"))
    expect(sch).toBeDefined()
    expect(sch!.text).toMatch(/\(kicad_sch/)
    // A schematic-only design is the normal case before M9. The board converter failing
    // must not take the schematic with it.
    expect(result.value.length).toBeGreaterThanOrEqual(1)
  })

  it("SVG: renders the schematic", async () => {
    const result = await svgExporter.export(await laidOut())

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value[0]!.text).toContain("<svg")
  })

  it("reports a failure as a Result rather than throwing", async () => {
    // These packages throw; our contract is Result. A schematic-only design has no board,
    // and asking for Gerbers should reach the UI as a message.
    const gerber = tscircuitExporters.find((e) => e.id === "gerber")!
    const result = await gerber.export(build())

    if (!result.ok) {
      expect(result.error[0]?.code).toBe("EXPORT_FAILED")
      expect(result.error[0]?.hint).toBeTruthy()
    }
    // Either outcome is acceptable; throwing is not, and reaching this line proves it did
    // not.
    expect(typeof result.ok).toBe("boolean")
  })
})

describe("LTspice .asc", () => {
  it("parses back into the components it was given", async () => {
    const { asc } = writeLtspiceAsc(await laidOut())
    const file = parseAsc(asc)
    const components = componentsByName(file)

    expect(file.version).toBe(4)
    expect(components.get("R1")?.symbol).toBe("res")
    expect(components.get("C1")?.symbol).toBe("cap")
  })

  it("keeps the value the author wrote", async () => {
    const { asc } = writeLtspiceAsc(await laidOut())
    const components = componentsByName(parseAsc(asc))

    // "10k" is what LTspice expects and what a person typed; 10000 is a lossy rendering.
    expect(components.get("R1")?.value).toBe("10k")
    expect(components.get("C1")?.value).toBe("100nF")
    // The ohm sign is valid in circuit-json's display string and not in an .asc value.
    expect(components.get("R1")?.value).not.toContain("Ω")
  })

  it("calls ground 0, which is what SPICE means by a reference node", async () => {
    const { asc } = writeLtspiceAsc(await laidOut())
    const nets = netsFromFlags(parseAsc(asc))

    // A netlist with a net literally named GND and no node 0 simulates with no reference
    // and fails in a way that looks like a circuit problem, not an export problem.
    expect(nets.has("0")).toBe(true)
    expect(nets.has("GND")).toBe(false)
  })

  it("flags a signal net under its own name", async () => {
    const { asc } = writeLtspiceAsc(await laidOut())
    const nets = netsFromFlags(parseAsc(asc))

    expect(nets.get("VOUT")?.length).toBeGreaterThanOrEqual(2)
  })

  it("puts every symbol on LTspice's 16-unit grid", async () => {
    const { asc } = writeLtspiceAsc(await laidOut())
    const file = parseAsc(asc)

    for (const symbol of file.symbols) {
      // Off-grid symbols will not connect to anything a user draws afterwards.
      expect((symbol.x + 16) % 16).toBe(0)
      expect((symbol.y + 16) % 16).toBe(0)
    }
  })

  it("names what it could not export instead of drawing the wrong symbol", async () => {
    // An NE555 is a real part with a real pinout and no LTspice built-in symbol — the
    // honest case, rather than a made-up one.
    const design = build([
      ...RC_LOWPASS,
      { type: "add_component", partRef: "t0:ne555", name: "U1", props: {} },
    ])
    const { asc, skipped } = writeLtspiceAsc(await laidOut(design))

    expect(skipped).toEqual([{ name: "U1", ftype: "simple_chip" }])
    // And the file itself says so, so someone reading it later does not have to guess.
    expect(parseAsc(asc).comments.join(" ")).toContain("U1")
  })

  it("carries an analysis directive when asked", async () => {
    const { asc } = writeLtspiceAsc(await laidOut(), { directive: ".ac dec 100 1 1meg" })
    expect(parseAsc(asc).directives).toContain(".ac dec 100 1 1meg")
  })

  it("exports through the Exporter interface too", async () => {
    const result = await ltspiceExporter.export(await laidOut())

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value[0]!.filename).toMatch(/\.asc$/)
      expect(parseAsc(result.value[0]!.text!).symbols.length).toBeGreaterThan(0)
    }
  })
})

describe("the .asc parser itself", () => {
  it("attributes SYMATTRs to the symbol that opened the block", () => {
    // The one piece of state in the format. A grep-based check would pass on a file whose
    // attributes had drifted onto the wrong symbol; this is why the test parses.
    const file = parseAsc(
      [
        "Version 4",
        "SHEET 1 880 680",
        "SYMBOL res 96 80 R0",
        "SYMATTR InstName R1",
        "SYMATTR Value 10k",
        "SYMBOL cap 208 80 R0",
        "SYMATTR InstName C1",
        "SYMATTR Value 100nF",
      ].join("\n"),
    )

    const byName = componentsByName(file)
    expect(byName.get("R1")?.value).toBe("10k")
    expect(byName.get("C1")?.value).toBe("100nF")
  })

  it("rejects an attribute with no symbol, pointing at the line", () => {
    expect(() => parseAsc("Version 4\nSYMATTR InstName R1")).toThrow(AscParseError)
    try {
      parseAsc("Version 4\nSYMATTR InstName R1")
    } catch (error) {
      expect((error as AscParseError).line).toBe(2)
    }
  })

  it("rejects a non-integer coordinate", () => {
    expect(() => parseAsc("Version 4\nSYMBOL res 96.5 80 R0")).toThrow(/integer/)
  })

  it("ignores lines it does not need", () => {
    const file = parseAsc(
      ["Version 4", "SHEET 1 880 680", "WINDOW 0 32 16 Left 2", "LINE Normal 0 0 16 16"].join("\n"),
    )
    expect(file.symbols).toHaveLength(0)
    expect(file.version).toBe(4)
  })

  it("reads wires and directives", () => {
    const file = parseAsc(
      ["Version 4", "SHEET 1 880 680", "WIRE 0 0 64 0", "TEXT 0 648 Left 2 !.tran 10m"].join("\n"),
    )
    expect(file.wires).toEqual([{ x1: 0, y1: 0, x2: 64, y2: 0 }])
    expect(file.directives).toEqual([".tran 10m"])
  })
})
