/**
 * Exporters we did not write.
 *
 * Every one of these is a thin adapter over a tscircuit package (principle 1). The work
 * here is translating our `Design` into what each package expects and its output into
 * `Artifact[]` — not producing SPICE, KiCad or Gerber, which tscircuit already does and
 * does better than a second implementation would.
 *
 * The APIs below were read from each package rather than assumed; where the real shape
 * differed from the plan it is noted at the call site.
 */

import type { AnyCircuitElement } from "circuit-json"
import type { Result, ValidationError } from "@syntrix/shared"
import { err, ok, validationError } from "@syntrix/shared"
import type { Design } from "@syntrix/core"
import type { Artifact, ExportContext, Exporter } from "./types"

/**
 * Run an exporter's body, turning a thrown error into a `Result`.
 *
 * These packages throw; our contract is `Result` (principle: Result for domain failures).
 * An export that fails is a normal outcome — a schematic-only design has no board to make
 * Gerbers from — and should reach the UI as a message rather than a stack trace.
 */
const guard = async (
  id: string,
  work: () => Promise<Artifact[]> | Artifact[],
): Promise<Result<Artifact[], ValidationError[]>> => {
  try {
    return ok(await work())
  } catch (cause) {
    return err([
      validationError(
        "EXPORT_FAILED",
        `${id}: ${cause instanceof Error ? cause.message : String(cause)}`,
        "Check that the design has the layer this format needs — a schematic-only design " +
          "has no board outline, pads or traces to export.",
      ),
    ])
  }
}

const text = (filename: string, mime: string, body: string): Artifact => ({
  filename,
  mime,
  text: body,
})

const baseName = (design: Design): string => (design.id || "design").replace(/[^a-zA-Z0-9_-]/g, "_")

/** The document as the tscircuit exporters want it: a plain element array. */
const circuit = (design: Design): AnyCircuitElement[] => design.circuit

// ---------------------------------------------------------------------------- SPICE

export const spiceExporter: Exporter = {
  id: "spice",
  label: "SPICE netlist",
  ext: "cir",
  mime: "text/plain",
  since: "M5",
  export: (design) =>
    guard("spice", async () => {
      // `circuitJsonToSpice` returns a SpiceNetlist object, not a string — the string
      // comes from `convertSpiceNetlistToString`.
      const { circuitJsonToSpice, convertSpiceNetlistToString } =
        await import("circuit-json-to-spice")
      const netlist = circuitJsonToSpice(circuit(design) as never)
      return [text(`${baseName(design)}.cir`, "text/plain", convertSpiceNetlistToString(netlist))]
    }),
}

// ------------------------------------------------------------------------------ BOM

/**
 * Bill of materials.
 *
 * `circuit-json-to-bom-csv` builds a **purchasing** BOM: it emits one row per component
 * that carries a distributor SKU, and nothing at all for one that does not. Verified —
 * a design of a 10k resistor and a 100nF capacitor produces an empty string.
 *
 * That is the right behaviour for its job and the wrong one for ours. An engineer wants
 * the parts list long before anyone has chosen a supplier: it is how you check that R3 is
 * really meant to be 4.7k, and it is what goes in a design review. So this exporter
 * writes the engineering BOM itself — refdes, value, package, footprint verification —
 * and merges in the supplier columns tscircuit produces when there are any.
 *
 * This is the "build only what tscircuit lacks" line (principle 1) in its usual place:
 * not a whole format, a missing column.
 */
export const bomExporter: Exporter = {
  id: "bom-csv",
  label: "Bill of materials (CSV)",
  ext: "csv",
  mime: "text/csv",
  since: "M5",
  export: (design) =>
    guard("bom-csv", async () => {
      const { convertCircuitJsonToBomRows } = await import("circuit-json-to-bom-csv")

      // Supplier rows, keyed by refdes, when any part has been sourced.
      const supplierRows = new Map<string, Record<string, unknown>>()
      try {
        const rows = (await convertCircuitJsonToBomRows({
          circuitJson: circuit(design) as never,
        })) as unknown as Array<Record<string, unknown>>
        for (const row of rows) {
          const refdes = String(row["Designator"] ?? row["designator"] ?? "")
          if (refdes) supplierRows.set(refdes, row)
        }
      } catch {
        /* an unsourced design is the normal case, not a failure */
      }

      const header = [
        "Designator",
        "Value",
        "Type",
        "Footprint",
        "FootprintVerified",
        "MPN",
        "Supplier",
        "SupplierPart",
      ]

      const lines = [header.join(",")]
      for (const component of sourceComponents(design)) {
        const meta = design.meta[String(component["source_component_id"])]
        const supplier = supplierRows.get(String(component["name"] ?? ""))

        lines.push(
          [
            component["name"],
            engineeringValue(component),
            String(component["ftype"] ?? "").replace(/^simple_/, ""),
            supplier?.["Footprint"] ?? "",
            // An unverified footprint is the most expensive mistake in this domain, so it
            // is a column in the BOM rather than something you find out at assembly.
            meta?.footprintVerification ?? "unverified",
            supplier?.["MPN"] ?? supplier?.["mpn"] ?? "",
            supplier?.["Supplier"] ?? "",
            supplier?.["Supplier Part Number"] ?? "",
          ]
            .map(csvCell)
            .join(","),
        )
      }

      return [text(`${baseName(design)}-bom.csv`, "text/csv", `${lines.join("\n")}\n`)]
    }),
}

/** Every source_component, as a loosely-typed record. */
const sourceComponents = (design: Design): Array<Record<string, unknown>> =>
  design.circuit
    .filter((element) => element.type === "source_component")
    .map((element) => element as unknown as Record<string, unknown>)

/** The value as the author wrote it, falling back to the parsed number. */
const engineeringValue = (component: Record<string, unknown>): string => {
  for (const field of ["resistance", "capacitance", "inductance", "voltage", "current"]) {
    const display = component[`display_${field}`]
    if (typeof display === "string") return display
    const numeric = component[field]
    if (typeof numeric === "number" && numeric !== 0) return String(numeric)
  }
  return ""
}

/** CSV quoting: a value with a comma, quote or newline in it has to be quoted. */
const csvCell = (value: unknown): string => {
  const cell = value === undefined || value === null ? "" : String(value)
  return /[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell
}

// ------------------------------------------------------------------------- pick & place

export const pnpExporter: Exporter = {
  id: "pnp-csv",
  label: "Pick and place (CSV)",
  ext: "csv",
  mime: "text/csv",
  since: "M5",
  export: (design) =>
    guard("pnp-csv", async () => {
      const { convertCircuitJsonToPickAndPlaceCsv } = await import("circuit-json-to-pnp-csv")
      return [
        text(
          `${baseName(design)}-pnp.csv`,
          "text/csv",
          convertCircuitJsonToPickAndPlaceCsv(circuit(design) as never),
        ),
      ]
    }),
}

// ---------------------------------------------------------------------------- KiCad

/**
 * KiCad schematic, board and project.
 *
 * The converters are **stateful builders**, not functions: construct with the circuit
 * json, `runUntilFinished()`, then `getOutputString()`. That is worth stating because
 * the obvious guess — a `convertCircuitJsonToKicadSch(json)` function — does not exist.
 */
export const kicadExporter: Exporter = {
  id: "kicad",
  label: "KiCad project",
  ext: "kicad_sch",
  mime: "text/plain",
  since: "M5",
  export: (design) =>
    guard("kicad", async () => {
      const {
        CircuitJsonToKicadSchConverter,
        CircuitJsonToKicadPcbConverter,
        CircuitJsonToKicadProConverter,
      } = await import("circuit-json-to-kicad")

      const name = baseName(design)
      const artifacts: Artifact[] = []

      const sch = new CircuitJsonToKicadSchConverter(circuit(design) as never)
      sch.runUntilFinished()
      artifacts.push(text(`${name}.kicad_sch`, "text/plain", sch.getOutputString()))

      // A design with no board still has a schematic worth exporting, so a failing board
      // converter must not take the schematic with it.
      try {
        const pcb = new CircuitJsonToKicadPcbConverter(circuit(design) as never)
        pcb.runUntilFinished()
        artifacts.push(text(`${name}.kicad_pcb`, "text/plain", pcb.getOutputString()))
      } catch {
        /* no board layer yet — expected before M9 */
      }

      try {
        const pro = new CircuitJsonToKicadProConverter(circuit(design) as never)
        pro.runUntilFinished()
        artifacts.push(text(`${name}.kicad_pro`, "application/json", pro.getOutputString()))
      } catch {
        /* the project file needs a board too */
      }

      return artifacts
    }),
}

// ------------------------------------------------------------------------------- SVG

export const svgExporter: Exporter = {
  id: "svg",
  label: "Schematic (SVG)",
  ext: "svg",
  mime: "image/svg+xml",
  since: "M5",
  export: (design) =>
    guard("svg", async () => {
      const { convertCircuitJsonToSchematicSvg } = await import("circuit-to-svg")
      return [
        text(
          `${baseName(design)}.svg`,
          "image/svg+xml",
          convertCircuitJsonToSchematicSvg(circuit(design) as never),
        ),
      ]
    }),
}

export const pcbSvgExporter: Exporter = {
  id: "pcb-svg",
  label: "Board (SVG)",
  ext: "svg",
  mime: "image/svg+xml",
  since: "M5",
  export: (design) =>
    guard("pcb-svg", async () => {
      const { convertCircuitJsonToPcbSvg } = await import("circuit-to-svg")
      return [
        text(
          `${baseName(design)}-pcb.svg`,
          "image/svg+xml",
          convertCircuitJsonToPcbSvg(circuit(design) as never),
        ),
      ]
    }),
}

// ---------------------------------------------------------------------------- Gerber

export const gerberExporter: Exporter = {
  id: "gerber",
  label: "Gerber + drill",
  ext: "gbr",
  mime: "text/plain",
  since: "M9",
  export: (design) =>
    guard("gerber", async () => {
      // `convertCircuitJsonToGerberFiles` does the whole job — layers, apertures and
      // stringification — and returns a filename → contents map. The lower-level
      // `convertCircuitJsonToGerberCommands` + `stringifyGerberCommandLayers` pair is
      // also exported, but reaching for it would mean owning the layer naming, which is
      // exactly the fabrication detail worth not owning.
      const {
        convertCircuitJsonToGerberFiles,
        convertCircuitJsonToExcellonDrillCommands,
        stringifyExcellonDrill,
      } = await import("circuit-json-to-gerber")

      const name = baseName(design)
      const files = convertCircuitJsonToGerberFiles(circuit(design) as never) as Record<
        string,
        string
      >

      const artifacts = Object.entries(files).map(([layer, body]) =>
        text(`${name}-${layer}.gbr`, "text/plain", body),
      )

      const drill = convertCircuitJsonToExcellonDrillCommands({
        circuitJson: circuit(design) as never,
        is_plated: true,
      })
      artifacts.push(text(`${name}-drill.drl`, "text/plain", stringifyExcellonDrill(drill)))

      return artifacts
    }),
}

// ------------------------------------------------------------------------------- DSN

/**
 * Specctra DSN — the escape hatch.
 *
 * tscircuit's autorouter handles routing (ADR-0012), so this is not how boards get
 * routed here. It exists so a board can leave for Freerouting or a commercial router
 * without anyone having to reverse-engineer an export, which is the kind of lock-in an
 * open tool should not have.
 */
export const dsnExporter: Exporter = {
  id: "dsn",
  label: "Specctra DSN",
  ext: "dsn",
  mime: "text/plain",
  since: "M9",
  export: (design) =>
    guard("dsn", async () => {
      const { convertCircuitJsonToDsnString } = await import("dsn-converter")
      return [
        text(
          `${baseName(design)}.dsn`,
          "text/plain",
          convertCircuitJsonToDsnString(circuit(design) as never),
        ),
      ]
    }),
}

/** Everything that wraps a tscircuit package, in registration order. */
export const tscircuitExporters: Exporter[] = [
  spiceExporter,
  bomExporter,
  pnpExporter,
  kicadExporter,
  svgExporter,
  pcbSvgExporter,
  gerberExporter,
  dsnExporter,
]

/** Re-exported for tests that need to build an `ExportContext` without importing types. */
export type { ExportContext }
