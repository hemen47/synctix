/**
 * Schematic drawing conventions.
 *
 * These encode how engineers expect a schematic to read, not how a graph layout
 * algorithm would naturally draw one. Signal flows left to right, power comes from
 * above, ground goes below, and passives sit inline with the signal rather than being
 * boxed like an IC.
 */

import type { AnyCircuitElement } from "circuit-json"
import type { PortSide } from "./types"

type Port = Extract<AnyCircuitElement, { type: "source_port" }>

/** Symbol body size in mm, by ftype. Drawn on the 1.27 mm (50 mil) grid. */
const SYMBOL_SIZES: Record<string, { width: number; height: number }> = {
  simple_resistor: { width: 2.54, height: 1.27 },
  simple_capacitor: { width: 2.54, height: 1.27 },
  simple_inductor: { width: 2.54, height: 1.27 },
  simple_diode: { width: 2.54, height: 1.27 },
  simple_led: { width: 2.54, height: 1.27 },
  simple_fuse: { width: 2.54, height: 1.27 },
  simple_crystal: { width: 2.54, height: 1.27 },
  simple_ground: { width: 1.27, height: 1.27 },
  simple_power_source: { width: 2.54, height: 2.54 },
  simple_voltage_source: { width: 2.54, height: 2.54 },
  simple_current_source: { width: 2.54, height: 2.54 },
  simple_battery: { width: 2.54, height: 2.54 },
  simple_transistor: { width: 3.81, height: 3.81 },
  simple_mosfet: { width: 3.81, height: 3.81 },
  simple_op_amp: { width: 5.08, height: 5.08 },
  simple_potentiometer: { width: 2.54, height: 2.54 },
  simple_push_button: { width: 2.54, height: 2.54 },
  simple_switch: { width: 2.54, height: 2.54 },
}

const DEFAULT_CHIP = { width: 7.62, height: 5.08 }
/** Vertical pitch between pins on a box symbol. One grid step. */
export const PIN_PITCH_MM = 1.27

/**
 * Size a symbol.
 *
 * A chip grows with its pin count: an 8-pin SOIC drawn the same size as a 32-pin QFP
 * would either crowd its pins or waste half the sheet.
 */
export const symbolSize = (ftype: string, pinCount: number): { width: number; height: number } => {
  const fixed = SYMBOL_SIZES[ftype]
  if (fixed) return fixed

  // Box symbols: pins split between the two vertical sides.
  const perSide = Math.max(1, Math.ceil(pinCount / 2))
  return {
    width: DEFAULT_CHIP.width,
    height: Math.max(DEFAULT_CHIP.height, (perSide + 1) * PIN_PITCH_MM),
  }
}

/** Two-terminal parts are drawn inline, with one pin at each end. */
export const isInlinePassive = (ftype: string): boolean =>
  [
    "simple_resistor",
    "simple_capacitor",
    "simple_inductor",
    "simple_diode",
    "simple_led",
    "simple_fuse",
    "simple_crystal",
  ].includes(ftype)

const POWER_NAMES = /^(vcc|vdd|v\+|vin|vout|vbus|3v3|5v|12v|avcc|vreg|v3)$/i
const GROUND_NAMES = /^(gnd|ground|vss|agnd|dgnd|vee|v-)$/i

/**
 * Which side of the symbol a pin belongs on.
 *
 * Power north and ground south is the convention that makes a schematic scannable: you
 * can see the supply rails without tracing wires. Inputs west and outputs east make
 * signal flow left to right.
 */
export const sideForPin = (port: Port, ftype: string, index: number, total: number): PortSide => {
  const name = port.name ?? ""
  const hints = [name, ...(port.port_hints ?? [])]

  // Explicit electrical role beats any naming heuristic.
  if (port.provides_ground) return "south"
  if (port.requires_power || port.provides_power) {
    return hints.some((h) => GROUND_NAMES.test(h)) ? "south" : "north"
  }

  if (hints.some((h) => GROUND_NAMES.test(h))) return "south"
  if (hints.some((h) => POWER_NAMES.test(h))) return "north"

  // A two-terminal passive is inline: first pin west, second east.
  if (isInlinePassive(ftype)) return index === 0 ? "west" : "east"

  if (hints.some((h) => /^(out|output|q|vo)/i.test(h))) return "east"
  if (hints.some((h) => /^(in|input|d|clk|rst|reset|en|trig)/i.test(h))) return "west"

  // Otherwise split the remaining pins evenly: first half west, second half east.
  return index < Math.ceil(total / 2) ? "west" : "east"
}

/**
 * Nets drawn as labels rather than wires.
 *
 * A schematic with a wire from every IC's VCC pin to one distant supply symbol is
 * technically correct and unreadable. Power and ground get labels at the pin instead.
 */
export const isRailNet = (
  name: string | undefined,
  isPower?: boolean,
  isGround?: boolean,
): boolean => {
  if (isPower || isGround) return true
  if (!name) return false
  return POWER_NAMES.test(name) || GROUND_NAMES.test(name)
}

export const isGroundNet = (name: string | undefined, isGround?: boolean): boolean =>
  Boolean(isGround) || (name !== undefined && GROUND_NAMES.test(name))
