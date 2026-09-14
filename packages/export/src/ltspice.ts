/**
 * LTspice `.asc` export.
 *
 * One of the two exporters we write ourselves, because tscircuit has no LTspice path and
 * LTspice is still where a great many engineers actually simulate. A netlist alone is not
 * enough: people want to open the circuit, drag a component, and re-run.
 *
 * ## The format
 *
 * `.asc` is a flat, line-oriented text format on a fixed integer grid (16 units per
 * schematic "pitch"; LTspice's own default placement is on multiples of 16). The lines
 * that matter:
 *
 * ```
 * Version 4
 * SHEET 1 880 680
 * WIRE x1 y1 x2 y2
 * FLAG x y GND            ← net label; "0" and "GND" are ground
 * SYMBOL res 96 80 R0     ← symbol name, position, rotation/mirror
 * SYMATTR InstName R1
 * SYMATTR Value 10k
 * ```
 *
 * Coordinates are integers and Y grows **downward**, as in circuit-json. Symbol positions
 * are the symbol's own origin, not its centre, which is why each built-in carries an
 * offset below.
 *
 * ## What is not exported
 *
 * Anything with no LTspice built-in. LTspice ships symbols for passives, diodes,
 * transistors, sources and a generic op-amp; a microcontroller has no equivalent and is
 * emitted as a comment rather than as a wrong symbol. The exporter reports what it
 * skipped instead of producing a file that looks complete and is not.
 */

import type { AnyCircuitElement } from "circuit-json"
import type { Result, ValidationError } from "@syntrix/shared"
import { ok } from "@syntrix/shared"
import { buildIndex, electricalNets, type Design } from "@syntrix/core"
import type { Artifact, Exporter } from "./types"

/** LTspice's grid. Everything lands on a multiple of this. */
const GRID = 16

/** Roughly 4 LTspice units per mm, so a typical schematic fills a default sheet. */
const UNITS_PER_MM = 6.3

interface Builtin {
  /** The symbol name LTspice looks up in its library. */
  symbol: string
  /**
   * Where the symbol's first pin sits relative to its origin, in LTspice units. Placement
   * is by origin, so a symbol positioned at the component's centre would be visibly off.
   */
  offset: { x: number; y: number }
  /** Which SYMATTR carries the value, when the part has one. */
  valueFrom?: string
}

/**
 * ftype → LTspice built-in.
 *
 * Deliberately short. Every entry here is a symbol that ships with LTspice on every
 * install; anything else would produce a file that fails to open on someone else's
 * machine, which is worse than an honest omission.
 */
const BUILTINS: Record<string, Builtin> = {
  simple_resistor: { symbol: "res", offset: { x: 16, y: 16 }, valueFrom: "resistance" },
  simple_capacitor: { symbol: "cap", offset: { x: 16, y: 16 }, valueFrom: "capacitance" },
  simple_inductor: { symbol: "ind", offset: { x: 16, y: 16 }, valueFrom: "inductance" },
  simple_diode: { symbol: "diode", offset: { x: 16, y: 16 } },
  simple_led: { symbol: "LED", offset: { x: 16, y: 16 } },
  simple_transistor: { symbol: "npn", offset: { x: 64, y: 32 } },
  simple_mosfet: { symbol: "nmos", offset: { x: 64, y: 32 } },
  simple_voltage_source: { symbol: "voltage", offset: { x: 16, y: 16 }, valueFrom: "voltage" },
  simple_power_source: { symbol: "voltage", offset: { x: 16, y: 16 }, valueFrom: "voltage" },
  simple_current_source: { symbol: "current", offset: { x: 16, y: 16 }, valueFrom: "current" },
  simple_op_amp: { symbol: "Opamps\\\\opamp2", offset: { x: 64, y: 48 } },
}

export interface LtspiceOptions {
  /** Analysis card appended as a `.tran`/`.ac` directive, e.g. ".tran 10m". */
  directive?: string
  /** Sheet size in LTspice units. The default matches LTspice's own new-file sheet. */
  sheet?: { width: number; height: number }
}

export interface LtspiceResult {
  asc: string
  /** Components with no LTspice built-in, named so the caller can say what was dropped. */
  skipped: Array<{ name: string; ftype: string }>
}

const snap = (value: number): number => Math.round(value / GRID) * GRID

/**
 * Write the `.asc`.
 *
 * Positions come from the schematic layer when it exists and from a simple row otherwise:
 * an LTspice file where every symbol sits at the origin is not openable in any useful
 * sense, so a fallback layout is better than faithful nothing.
 */
export const writeLtspiceAsc = (design: Design, options: LtspiceOptions = {}): LtspiceResult => {
  const view = buildIndex(design.circuit)
  const sheet = options.sheet ?? { width: 880, height: 680 }

  const lines: string[] = ["Version 4", `SHEET 1 ${sheet.width} ${sheet.height}`]
  const skipped: LtspiceResult["skipped"] = []

  const positions = schematicPositions(design.circuit)
  let fallbackX = 0

  for (const component of view.components.values()) {
    const ftype = component.ftype ?? ""
    const builtin = BUILTINS[ftype]

    // A ground symbol is not missing — it is expressed as a `FLAG ... 0` on the net
    // below, which is what LTspice's own GND symbol compiles to. Reporting it as
    // unexportable would send someone looking for a problem that is not there.
    if (ftype === "simple_ground") continue

    if (!builtin) {
      // Recorded in the file as well as returned, so someone reading the .asc later finds
      // out what is missing from the file itself.
      lines.push(`* ${component.name} (${ftype || "unknown"}) has no LTspice built-in symbol`)
      skipped.push({ name: component.name, ftype })
      continue
    }

    const placed = positions.get(component.source_component_id)
    const x = placed ? snap(placed.x * UNITS_PER_MM) : snap(fallbackX * UNITS_PER_MM)
    const y = placed ? snap(placed.y * UNITS_PER_MM) : GRID * 4
    if (!placed) fallbackX += 20

    lines.push(`SYMBOL ${builtin.symbol} ${x - builtin.offset.x} ${y - builtin.offset.y} R0`)
    lines.push(`SYMATTR InstName ${component.name}`)

    const value = displayValue(component, builtin)
    if (value) lines.push(`SYMATTR Value ${value}`)
  }

  // Nets become FLAGs rather than wires.
  //
  // LTspice treats two points with the same FLAG name as connected, exactly as a
  // schematic net label does, so a netlist-faithful file needs no wire geometry at all.
  // Drawing wires would mean re-deriving orthogonal routes in LTspice's coordinate space
  // and getting them wrong; labels are unambiguous and are what an engineer would have
  // drawn for a bus anyway.
  for (const net of electricalNets(view)) {
    const label = netLabel(net, view)
    if (!label) continue

    for (const portId of net.ports) {
      const port = view.byId.get(portId)
      if (!port || port.type !== "source_port" || !port.source_component_id) continue
      const component = view.components.get(port.source_component_id)
      if (!component) continue

      const placed = positions.get(component.source_component_id)
      const x = placed ? snap(placed.x * UNITS_PER_MM) : 0
      const y = placed ? snap(placed.y * UNITS_PER_MM) : GRID * 4
      lines.push(`FLAG ${x} ${y + GRID * (port.pin_number === 1 ? -2 : 2)} ${label}`)
    }
  }

  if (options.directive) lines.push(`TEXT 0 ${sheet.height - 32} Left 2 !${options.directive}`)

  return { asc: `${lines.join("\n")}\n`, skipped }
}

/**
 * The net's name in LTspice terms.
 *
 * Ground is `0` — SPICE's global reference, and what LTspice's own GND symbol produces.
 * Getting this wrong gives a netlist that simulates and has no reference node, which
 * fails in a way that looks like a circuit problem rather than an export problem.
 */
const netLabel = (
  net: ReturnType<typeof electricalNets>[number],
  view: ReturnType<typeof buildIndex>,
): string | undefined => {
  if (!net.name) return undefined
  for (const netId of net.netIds) {
    const element = view.nets.get(netId) as unknown as { is_ground?: boolean } | undefined
    if (element?.is_ground) return "0"
  }
  return /^(gnd|ground|vss|agnd|dgnd)$/i.test(net.name) ? "0" : net.name
}

/** Where the schematic layer put each component, if it has been laid out. */
const schematicPositions = (
  elements: AnyCircuitElement[],
): Map<string, { x: number; y: number }> => {
  const positions = new Map<string, { x: number; y: number }>()
  for (const element of elements) {
    if (element.type !== "schematic_component") continue
    const record = element as unknown as {
      source_component_id?: string
      center?: { x: number; y: number }
    }
    if (record.source_component_id && record.center) {
      positions.set(record.source_component_id, record.center)
    }
  }
  return positions
}

/** The value as the author wrote it, which LTspice parses the same way tscircuit does. */
const displayValue = (
  component: { [key: string]: unknown },
  builtin: Builtin,
): string | undefined => {
  if (!builtin.valueFrom) return undefined
  const display = component[`display_${builtin.valueFrom}`]
  if (typeof display === "string") return display.replace(/[Ω]/g, "")
  const numeric = component[builtin.valueFrom]
  return typeof numeric === "number" ? String(numeric) : undefined
}

export const ltspiceExporter: Exporter = {
  id: "ltspice-asc",
  label: "LTspice schematic (.asc)",
  ext: "asc",
  mime: "text/plain",
  since: "M5",
  async export(design, ctx): Promise<Result<Artifact[], ValidationError[]>> {
    const options = (ctx?.options ?? {}) as LtspiceOptions
    const { asc } = writeLtspiceAsc(design, options)
    return ok([
      {
        filename: `${(design.id || "design").replace(/[^a-zA-Z0-9_-]/g, "_")}.asc`,
        mime: "text/plain",
        text: asc,
      },
    ])
  },
}
