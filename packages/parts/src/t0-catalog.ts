/**
 * T0 — the generic catalog, in code.
 *
 * Always available: no network, no database, no API key. This is what makes SYNTRIX
 * usable offline and what the agent falls back to when a federated source is down.
 *
 * Every entry carries a real pinout with `altNames` (which become `port_hints`, so a pin
 * is addressable as "VCC" or "OUT" rather than only by number) and a footprinter string,
 * which resolves to a verified land pattern.
 *
 * Licence note: these are generic parts described from public datasheets. Pin numbering
 * and package dimensions are facts, not creative work; nothing here is copied from a
 * licensed symbol library.
 */

import type { PartDefinition, Pin, PinKind } from "./types"

const PROVENANCE = { source: "syntrix-t0", fetchedAt: "2026-09-14T00:00:00.000Z" }

interface PinInput {
  n: number | string
  name: string
  kind: PinKind
  alt?: string[]
  fn?: string[]
}

const pins = (list: PinInput[]): Pin[] =>
  list.map((p) => ({
    number: p.n,
    name: p.name,
    kind: p.kind,
    functions: p.fn ?? [],
    // The pin number itself is always an alias, so `pin: 1` and `pin: "1"` both resolve.
    altNames: [...new Set([String(p.n), p.name, ...(p.alt ?? [])])],
  }))

interface PartInput {
  id: string
  mpn?: string
  manufacturer?: string
  category: string
  description: string
  ftype: string
  pinList: PinInput[]
  symbolRef: string
  footprinter?: string
  jedec?: string
  electrical?: Record<string, unknown>
  spiceModel?: string
  spiceMapping?: Record<string, number>
  datasheetUrl?: string
}

const part = (input: PartInput): PartDefinition => ({
  id: input.id,
  ...(input.mpn ? { mpn: input.mpn } : {}),
  ...(input.manufacturer ? { manufacturer: input.manufacturer } : {}),
  category: input.category,
  description: input.description,
  ftype: input.ftype,
  pins: pins(input.pinList),
  symbol: { source: "schematic-symbols", ref: input.symbolRef },
  footprint: {
    ...(input.footprinter ? { footprinterString: input.footprinter } : {}),
    ...(input.jedec ? { jedecPackage: input.jedec } : {}),
    // Footprinter-generated land patterns are verified; a part with no footprinter
    // string stays unverified until someone supplies geometry.
    verification: input.footprinter ? "verified" : "unverified",
  },
  electrical: input.electrical ?? {},
  ...(input.spiceModel || input.spiceMapping
    ? {
        spice: {
          ...(input.spiceModel ? { modelText: input.spiceModel } : {}),
          mapping: input.spiceMapping ?? {},
        },
      }
    : {}),
  ...(input.datasheetUrl ? { datasheetUrl: input.datasheetUrl } : {}),
  distributors: [],
  lifecycle: "active",
  license: "public-domain (generic part, datasheet facts)",
  provenance: PROVENANCE,
  version: 1,
})

// ---------------------------------------------------------------- passives

const TWO_PIN_PASSIVE: PinInput[] = [
  { n: 1, name: "pin1", kind: "passive", alt: ["pos", "left", "a"] },
  { n: 2, name: "pin2", kind: "passive", alt: ["neg", "right", "b"] },
]

const POLARISED: PinInput[] = [
  { n: 1, name: "pin1", kind: "passive", alt: ["pos", "anode", "+"] },
  { n: 2, name: "pin2", kind: "passive", alt: ["neg", "cathode", "-"] },
]

const passives: PartDefinition[] = [
  part({
    id: "t0:resistor",
    category: "Resistor",
    description: "Generic resistor",
    ftype: "simple_resistor",
    pinList: TWO_PIN_PASSIVE,
    symbolRef: "boxresistor_horz",
    footprinter: "0603",
    jedec: "0603",
    electrical: { tolerance: "1%", power_rating_w: 0.1 },
    spiceMapping: { "1": 0, "2": 1 },
  }),
  part({
    id: "t0:capacitor",
    category: "Capacitor",
    description: "Generic ceramic capacitor",
    ftype: "simple_capacitor",
    pinList: TWO_PIN_PASSIVE,
    symbolRef: "capacitor_horz",
    footprinter: "0603",
    jedec: "0603",
    electrical: { dielectric: "X7R", voltage_rating_v: 50 },
    spiceMapping: { "1": 0, "2": 1 },
  }),
  part({
    id: "t0:capacitor_electrolytic",
    category: "Capacitor",
    description: "Generic polarised electrolytic capacitor",
    ftype: "simple_capacitor",
    pinList: POLARISED,
    symbolRef: "capacitor_polarized_horz",
    footprinter: "electrolytic",
    electrical: { dielectric: "electrolytic", voltage_rating_v: 25, polarised: true },
    spiceMapping: { "1": 0, "2": 1 },
  }),
  part({
    id: "t0:inductor",
    category: "Inductor",
    description: "Generic inductor",
    ftype: "simple_inductor",
    pinList: TWO_PIN_PASSIVE,
    symbolRef: "inductor_horz",
    footprinter: "0805",
    spiceMapping: { "1": 0, "2": 1 },
  }),
  part({
    id: "t0:ferrite_bead",
    category: "Inductor",
    description: "Ferrite bead, for supply filtering",
    ftype: "simple_inductor",
    pinList: TWO_PIN_PASSIVE,
    symbolRef: "inductor_horz",
    footprinter: "0603",
    electrical: { impedance_at_100mhz_ohm: 600 },
  }),
  part({
    id: "t0:potentiometer",
    category: "Resistor",
    description: "Generic 3-terminal potentiometer",
    ftype: "simple_potentiometer",
    pinList: [
      { n: 1, name: "pin1", kind: "passive", alt: ["cw", "a"] },
      { n: 2, name: "wiper", kind: "passive", alt: ["w", "wiper"] },
      { n: 3, name: "pin3", kind: "passive", alt: ["ccw", "b"] },
    ],
    symbolRef: "potentiometer_horz",
    footprinter: "sot23",
  }),
  part({
    id: "t0:fuse",
    category: "Protection",
    description: "Generic resettable fuse",
    ftype: "simple_fuse",
    pinList: TWO_PIN_PASSIVE,
    symbolRef: "fuse_horz",
    footprinter: "1206",
  }),
  part({
    id: "t0:crystal",
    category: "Timing",
    description: "Two-terminal quartz crystal",
    ftype: "simple_crystal",
    pinList: TWO_PIN_PASSIVE,
    symbolRef: "crystal",
    footprinter: "hc49",
    electrical: { load_capacitance_pf: 18 },
  }),
]

// ---------------------------------------------------------------- semiconductors

const semiconductors: PartDefinition[] = [
  part({
    id: "t0:diode",
    category: "Diode",
    description: "Generic signal diode",
    ftype: "simple_diode",
    pinList: POLARISED,
    symbolRef: "diode_horz",
    footprinter: "sod123",
    spiceModel: ".model D_GENERIC D(IS=1e-14 N=1.0)",
    spiceMapping: { "1": 0, "2": 1 },
  }),
  part({
    id: "t0:schottky",
    category: "Diode",
    description: "Schottky diode, low forward drop",
    ftype: "simple_diode",
    pinList: POLARISED,
    symbolRef: "schottky_diode_horz",
    footprinter: "sod123",
    electrical: { forward_voltage_v: 0.35 },
    spiceModel: ".model D_SCHOTTKY D(IS=1e-7 N=1.05 RS=0.05)",
    spiceMapping: { "1": 0, "2": 1 },
  }),
  part({
    id: "t0:zener",
    category: "Diode",
    description: "Zener diode, for voltage clamping",
    ftype: "simple_diode",
    pinList: POLARISED,
    symbolRef: "zener_diode_horz",
    footprinter: "sod123",
    electrical: { zener_voltage_v: 5.1 },
    spiceModel: ".model D_ZENER D(IS=1e-14 BV=5.1 IBV=5e-3)",
    spiceMapping: { "1": 0, "2": 1 },
  }),
  part({
    id: "t0:tvs",
    category: "Protection",
    description: "TVS diode, for ESD and surge protection",
    ftype: "simple_diode",
    pinList: POLARISED,
    symbolRef: "diode_horz",
    footprinter: "sod123",
  }),
  part({
    id: "t0:led",
    category: "Optoelectronics",
    description: "Generic LED",
    ftype: "simple_led",
    pinList: POLARISED,
    symbolRef: "led_horz",
    footprinter: "0603",
    electrical: { forward_voltage_v: 2.0, forward_current_ma: 20 },
  }),
  part({
    id: "t0:npn",
    category: "Transistor",
    description: "Generic NPN bipolar transistor",
    ftype: "simple_transistor",
    pinList: [
      { n: 1, name: "base", kind: "input", alt: ["b", "base"], fn: ["base"] },
      { n: 2, name: "emitter", kind: "passive", alt: ["e", "emitter"], fn: ["emitter"] },
      { n: 3, name: "collector", kind: "passive", alt: ["c", "collector"], fn: ["collector"] },
    ],
    symbolRef: "npn_bjt_transistor",
    footprinter: "sot23",
    spiceModel: ".model Q_NPN NPN(BF=200 IS=1e-14 VAF=100)",
    spiceMapping: { "3": 0, "1": 1, "2": 2 },
  }),
  part({
    id: "t0:pnp",
    category: "Transistor",
    description: "Generic PNP bipolar transistor",
    ftype: "simple_transistor",
    pinList: [
      { n: 1, name: "base", kind: "input", alt: ["b", "base"], fn: ["base"] },
      { n: 2, name: "emitter", kind: "passive", alt: ["e", "emitter"], fn: ["emitter"] },
      { n: 3, name: "collector", kind: "passive", alt: ["c", "collector"], fn: ["collector"] },
    ],
    symbolRef: "pnp_bjt_transistor",
    footprinter: "sot23",
    spiceModel: ".model Q_PNP PNP(BF=200 IS=1e-14 VAF=100)",
    spiceMapping: { "3": 0, "1": 1, "2": 2 },
  }),
  part({
    id: "t0:nmos",
    category: "Transistor",
    description: "Generic N-channel MOSFET",
    ftype: "simple_mosfet",
    pinList: [
      { n: 1, name: "gate", kind: "input", alt: ["g", "gate"], fn: ["gate"] },
      { n: 2, name: "source", kind: "passive", alt: ["s", "source"], fn: ["source"] },
      { n: 3, name: "drain", kind: "passive", alt: ["d", "drain"], fn: ["drain"] },
    ],
    symbolRef: "nmos_transistor",
    footprinter: "sot23",
    spiceModel: ".model M_NMOS NMOS(VTO=2.0 KP=2e-5)",
    spiceMapping: { "3": 0, "1": 1, "2": 2 },
  }),
  part({
    id: "t0:pmos",
    category: "Transistor",
    description: "Generic P-channel MOSFET",
    ftype: "simple_mosfet",
    pinList: [
      { n: 1, name: "gate", kind: "input", alt: ["g", "gate"], fn: ["gate"] },
      { n: 2, name: "source", kind: "passive", alt: ["s", "source"], fn: ["source"] },
      { n: 3, name: "drain", kind: "passive", alt: ["d", "drain"], fn: ["drain"] },
    ],
    symbolRef: "pmos_transistor",
    footprinter: "sot23",
    spiceModel: ".model M_PMOS PMOS(VTO=-2.0 KP=2e-5)",
    spiceMapping: { "3": 0, "1": 1, "2": 2 },
  }),
]

// ---------------------------------------------------------------- power

const power: PartDefinition[] = [
  part({
    id: "t0:ams1117-3.3",
    mpn: "AMS1117-3.3",
    manufacturer: "Advanced Monolithic Systems",
    category: "Voltage Regulator",
    description: "AMS1117-3.3 — 1A low-dropout linear regulator, fixed 3.3V output, SOT-223",
    ftype: "simple_chip",
    pinList: [
      { n: 1, name: "GND", kind: "ground", alt: ["gnd", "vss", "ground"], fn: ["ground"] },
      { n: 2, name: "VOUT", kind: "power_out", alt: ["vout", "out", "output"], fn: ["power_out"] },
      { n: 3, name: "VIN", kind: "power_in", alt: ["vin", "in", "input"], fn: ["power_in"] },
      // SOT-223 has three leads *plus* a thermal tab. On the AMS1117 the tab is bonded
      // to VOUT internally, so it is a real pin: omitting it leaves a large pad
      // unconnected on the board and loses the part's heatsinking path.
      {
        n: 4,
        name: "TAB",
        kind: "power_out",
        alt: ["tab", "pad", "thermal"],
        fn: ["power_out", "thermal"],
      },
    ],
    symbolRef: "boxresistor_horz",
    footprinter: "sot223",
    jedec: "SOT-223",
    electrical: {
      voltage_out_v: 3.3,
      tab_connected_to: "VOUT",
      voltage_in_min_v: 4.75,
      voltage_in_max_v: 15,
      current_max_a: 1.0,
      dropout_voltage_v: 1.3,
      regulator_type: "LDO",
      output_type: "fixed",
    },
    datasheetUrl: "http://www.advanced-monolithic.com/pdf/ds1117.pdf",
  }),
  part({
    id: "t0:lm7805",
    mpn: "LM7805",
    category: "Voltage Regulator",
    description: "LM7805 — 1A linear regulator, fixed 5V output, TO-220",
    ftype: "simple_chip",
    pinList: [
      { n: 1, name: "VIN", kind: "power_in", alt: ["vin", "in"], fn: ["power_in"] },
      { n: 2, name: "GND", kind: "ground", alt: ["gnd", "ground"], fn: ["ground"] },
      { n: 3, name: "VOUT", kind: "power_out", alt: ["vout", "out"], fn: ["power_out"] },
    ],
    symbolRef: "boxresistor_horz",
    footprinter: "to220",
    jedec: "TO-220",
    electrical: {
      voltage_out_v: 5.0,
      voltage_in_min_v: 7.0,
      voltage_in_max_v: 35,
      current_max_a: 1.0,
      dropout_voltage_v: 2.0,
      regulator_type: "linear",
      output_type: "fixed",
    },
  }),
  part({
    id: "t0:lm1117-3.3",
    mpn: "LM1117-3.3",
    manufacturer: "Texas Instruments",
    category: "Voltage Regulator",
    description: "LM1117-3.3 — 800mA low-dropout linear regulator, fixed 3.3V output, SOT-223",
    ftype: "simple_chip",
    pinList: [
      { n: 1, name: "GND", kind: "ground", alt: ["gnd", "adj"], fn: ["ground"] },
      { n: 2, name: "VOUT", kind: "power_out", alt: ["vout", "out"], fn: ["power_out"] },
      { n: 3, name: "VIN", kind: "power_in", alt: ["vin", "in"], fn: ["power_in"] },
      {
        n: 4,
        name: "TAB",
        kind: "power_out",
        alt: ["tab", "pad", "thermal"],
        fn: ["power_out", "thermal"],
      },
    ],
    symbolRef: "boxresistor_horz",
    footprinter: "sot223",
    jedec: "SOT-223",
    electrical: {
      voltage_out_v: 3.3,
      tab_connected_to: "VOUT",
      voltage_in_min_v: 4.5,
      voltage_in_max_v: 15,
      current_max_a: 0.8,
      dropout_voltage_v: 1.2,
      regulator_type: "LDO",
      output_type: "fixed",
    },
  }),
  part({
    id: "t0:battery",
    category: "Power",
    description: "Generic battery / DC supply",
    ftype: "simple_battery",
    pinList: [
      { n: 1, name: "pos", kind: "power_out", alt: ["+", "vcc", "pos"] },
      { n: 2, name: "neg", kind: "ground", alt: ["-", "gnd", "neg"] },
    ],
    symbolRef: "battery_horz",
  }),
  part({
    id: "t0:vsource",
    category: "Simulation",
    description: "Independent voltage source (simulation)",
    ftype: "simple_voltage_source",
    pinList: [
      { n: 1, name: "pos", kind: "power_out", alt: ["+", "pos", "p"] },
      { n: 2, name: "neg", kind: "passive", alt: ["-", "neg", "n"] },
    ],
    symbolRef: "voltage_source",
    spiceMapping: { "1": 0, "2": 1 },
  }),
  part({
    id: "t0:isource",
    category: "Simulation",
    description: "Independent current source (simulation)",
    ftype: "simple_current_source",
    pinList: [
      { n: 1, name: "pos", kind: "power_out", alt: ["+", "pos"] },
      { n: 2, name: "neg", kind: "passive", alt: ["-", "neg"] },
    ],
    symbolRef: "current_source",
    spiceMapping: { "1": 0, "2": 1 },
  }),
  part({
    id: "t0:gnd",
    category: "Power",
    description: "Ground symbol",
    ftype: "simple_ground",
    pinList: [{ n: 1, name: "GND", kind: "ground", alt: ["gnd", "ground", "0"] }],
    symbolRef: "ground_horz",
  }),
]

// ---------------------------------------------------------------- ics

const ics: PartDefinition[] = [
  part({
    id: "t0:opamp",
    category: "Analog IC",
    description: "Generic single op-amp",
    ftype: "simple_op_amp",
    pinList: [
      { n: 1, name: "IN+", kind: "input", alt: ["in+", "noninv", "plus", "+"], fn: ["input"] },
      { n: 2, name: "IN-", kind: "input", alt: ["in-", "inv", "minus", "-"], fn: ["input"] },
      { n: 3, name: "OUT", kind: "output", alt: ["out", "output"], fn: ["output"] },
      { n: 4, name: "V+", kind: "power_in", alt: ["v+", "vcc", "vdd"], fn: ["power_in"] },
      { n: 5, name: "V-", kind: "power_in", alt: ["v-", "vee", "vss"], fn: ["power_in"] },
    ],
    symbolRef: "opamp_no_power",
    // Deliberately no footprint: a generic op-amp symbol has no committed package, and
    // claiming SOIC-8 would put a 5-pin symbol on an 8-pad land pattern. Choose a real
    // part (LM358, and so on) to get a verified footprint.
  }),
  part({
    id: "t0:lm358",
    mpn: "LM358",
    category: "Analog IC",
    description: "LM358 — dual low-power operational amplifier, SOIC-8",
    ftype: "simple_chip",
    pinList: [
      { n: 1, name: "OUT1", kind: "output", alt: ["out1"], fn: ["output"] },
      { n: 2, name: "IN1-", kind: "input", alt: ["in1-"], fn: ["input"] },
      { n: 3, name: "IN1+", kind: "input", alt: ["in1+"], fn: ["input"] },
      { n: 4, name: "GND", kind: "ground", alt: ["gnd", "v-", "vee"], fn: ["ground"] },
      { n: 5, name: "IN2+", kind: "input", alt: ["in2+"], fn: ["input"] },
      { n: 6, name: "IN2-", kind: "input", alt: ["in2-"], fn: ["input"] },
      { n: 7, name: "OUT2", kind: "output", alt: ["out2"], fn: ["output"] },
      { n: 8, name: "VCC", kind: "power_in", alt: ["vcc", "v+", "vdd"], fn: ["power_in"] },
    ],
    symbolRef: "opamp_no_power",
    footprinter: "soic8",
    jedec: "SOIC-8",
    electrical: { channels: 2, supply_min_v: 3, supply_max_v: 32, gbw_mhz: 1.1 },
  }),
  part({
    id: "t0:ne555",
    mpn: "NE555",
    category: "Timer",
    description: "NE555 — precision timer, astable and monostable, DIP-8 / SOIC-8",
    ftype: "simple_chip",
    pinList: [
      { n: 1, name: "GND", kind: "ground", alt: ["gnd", "vss"], fn: ["ground"] },
      { n: 2, name: "TRIG", kind: "input", alt: ["trig", "trigger"], fn: ["input"] },
      { n: 3, name: "OUT", kind: "output", alt: ["out", "output"], fn: ["output"] },
      { n: 4, name: "RESET", kind: "input", alt: ["reset", "rst"], fn: ["input"] },
      { n: 5, name: "CTRL", kind: "input", alt: ["ctrl", "cv", "control"], fn: ["input"] },
      { n: 6, name: "THRES", kind: "input", alt: ["thres", "threshold", "thr"], fn: ["input"] },
      { n: 7, name: "DISCH", kind: "open_drain", alt: ["disch", "discharge", "dis"] },
      { n: 8, name: "VCC", kind: "power_in", alt: ["vcc", "vdd", "v+"], fn: ["power_in"] },
    ],
    symbolRef: "boxresistor_horz",
    footprinter: "soic8",
    jedec: "SOIC-8",
    electrical: { supply_min_v: 4.5, supply_max_v: 16 },
  }),
  part({
    id: "t0:atmega328p",
    mpn: "ATmega328P",
    manufacturer: "Microchip",
    category: "Microcontroller",
    description: "ATmega328P — 8-bit AVR microcontroller, 32KB flash, TQFP-32",
    ftype: "simple_chip",
    // The full 32-pin map lands with the T1 catalogue; T0 carries the supply and reset
    // pins, which is what the agent needs to decouple and reset the part correctly.
    pinList: [
      { n: 4, name: "VCC", kind: "power_in", alt: ["vcc", "vdd"], fn: ["power_in"] },
      { n: 3, name: "GND", kind: "ground", alt: ["gnd", "vss"], fn: ["ground"] },
      { n: 18, name: "AVCC", kind: "power_in", alt: ["avcc"], fn: ["power_in"] },
      { n: 21, name: "AREF", kind: "passive", alt: ["aref"] },
      { n: 29, name: "RESET", kind: "input", alt: ["reset", "rst"], fn: ["input"] },
      { n: 7, name: "XTAL1", kind: "input", alt: ["xtal1"], fn: ["clock"] },
      { n: 8, name: "XTAL2", kind: "output", alt: ["xtal2"], fn: ["clock"] },
    ],
    symbolRef: "boxresistor_horz",
    jedec: "TQFP-32",
    electrical: { supply_min_v: 1.8, supply_max_v: 5.5, flash_kb: 32, core: "AVR" },
  }),
  part({
    id: "t0:esp32-wroom-32",
    mpn: "ESP32-WROOM-32",
    manufacturer: "Espressif",
    category: "Microcontroller",
    description: "ESP32-WROOM-32 — Wi-Fi and Bluetooth module, castellated SMD",
    ftype: "simple_chip",
    pinList: [
      { n: 1, name: "GND", kind: "ground", alt: ["gnd"], fn: ["ground"] },
      { n: 2, name: "3V3", kind: "power_in", alt: ["3v3", "vdd", "vcc"], fn: ["power_in"] },
      { n: 3, name: "EN", kind: "input", alt: ["en", "reset", "chip_pu"], fn: ["input"] },
      { n: 34, name: "TXD0", kind: "output", alt: ["txd0", "tx", "gpio1"], fn: ["uart_tx"] },
      { n: 35, name: "RXD0", kind: "input", alt: ["rxd0", "rx", "gpio3"], fn: ["uart_rx"] },
      { n: 25, name: "IO0", kind: "bidirectional", alt: ["io0", "gpio0", "boot"] },
    ],
    symbolRef: "boxresistor_horz",
    electrical: { supply_min_v: 3.0, supply_max_v: 3.6, wifi: true, bluetooth: true },
  }),
  part({
    id: "t0:ch340",
    mpn: "CH340G",
    category: "Interface IC",
    description: "CH340G — USB to UART bridge, SOIC-16",
    ftype: "simple_chip",
    // The full 16-pin map. A partial pinout on a 16-pad footprint leaves pads with no
    // net, which is a board that cannot be assembled correctly.
    pinList: [
      { n: 1, name: "GND", kind: "ground", alt: ["gnd"], fn: ["ground"] },
      { n: 2, name: "TXD", kind: "output", alt: ["txd", "tx"], fn: ["uart_tx"] },
      { n: 3, name: "RXD", kind: "input", alt: ["rxd", "rx"], fn: ["uart_rx"] },
      { n: 4, name: "V3", kind: "power_out", alt: ["v3", "vreg"], fn: ["power_out"] },
      { n: 5, name: "UD+", kind: "bidirectional", alt: ["ud+", "dp", "usb_dp", "d+"] },
      { n: 6, name: "UD-", kind: "bidirectional", alt: ["ud-", "dm", "usb_dm", "d-"] },
      { n: 7, name: "XI", kind: "input", alt: ["xi", "xtal1"], fn: ["clock"] },
      { n: 8, name: "XO", kind: "output", alt: ["xo", "xtal2"], fn: ["clock"] },
      { n: 9, name: "CTS", kind: "input", alt: ["cts", "ncts"] },
      { n: 10, name: "DSR", kind: "input", alt: ["dsr", "ndsr"] },
      { n: 11, name: "RI", kind: "input", alt: ["ri", "nri"] },
      { n: 12, name: "DCD", kind: "input", alt: ["dcd", "ndcd"] },
      { n: 13, name: "DTR", kind: "output", alt: ["dtr", "ndtr"] },
      { n: 14, name: "RTS", kind: "output", alt: ["rts", "nrts"] },
      { n: 15, name: "R232", kind: "input", alt: ["r232"] },
      { n: 16, name: "VCC", kind: "power_in", alt: ["vcc", "vdd"], fn: ["power_in"] },
    ],
    symbolRef: "boxresistor_horz",
    footprinter: "soic16",
    jedec: "SOIC-16",
  }),
]

// ---------------------------------------------------------------- electromechanical

const electromechanical: PartDefinition[] = [
  part({
    id: "t0:pushbutton",
    category: "Switch",
    description: "Momentary tactile pushbutton, SPST",
    ftype: "simple_push_button",
    // A tactile switch has four pads, not two: pins 1-2 are one terminal and 3-4 the
    // other, bridged inside the body. Declaring two pins would leave half the pads
    // unconnected on the board.
    pinList: [
      { n: 1, name: "A1", kind: "passive", alt: ["a", "a1", "1"] },
      { n: 2, name: "A2", kind: "passive", alt: ["a2", "2"] },
      { n: 3, name: "B1", kind: "passive", alt: ["b", "b1", "3"] },
      { n: 4, name: "B2", kind: "passive", alt: ["b2", "4"] },
    ],
    symbolRef: "push_button_normally_open_momentary",
    footprinter: "pushbutton",
    electrical: { internally_bridged: "1-2, 3-4" },
  }),
  part({
    id: "t0:header_2x1",
    category: "Connector",
    description: "2-pin 2.54mm pin header",
    ftype: "simple_pin_header",
    pinList: [
      { n: 1, name: "pin1", kind: "passive" },
      { n: 2, name: "pin2", kind: "passive" },
    ],
    symbolRef: "pinheader",
    footprinter: "pinrow2",
    electrical: { pitch_mm: 2.54, positions: 2 },
  }),
  part({
    id: "t0:header_4x1",
    category: "Connector",
    description: "4-pin 2.54mm pin header",
    ftype: "simple_pin_header",
    pinList: [1, 2, 3, 4].map((n) => ({ n, name: `pin${n}`, kind: "passive" as PinKind })),
    symbolRef: "pinheader",
    footprinter: "pinrow4",
    electrical: { pitch_mm: 2.54, positions: 4 },
  }),
  part({
    id: "t0:usb_c_receptacle",
    category: "Connector",
    description: "USB Type-C receptacle, 16-pin power and USB 2.0",
    ftype: "simple_connector",
    pinList: [
      { n: 1, name: "GND", kind: "ground", alt: ["gnd"], fn: ["ground"] },
      { n: 2, name: "VBUS", kind: "power_out", alt: ["vbus", "5v"], fn: ["power_out"] },
      { n: 3, name: "CC1", kind: "bidirectional", alt: ["cc1"] },
      { n: 4, name: "CC2", kind: "bidirectional", alt: ["cc2"] },
      { n: 5, name: "D+", kind: "bidirectional", alt: ["d+", "dp"] },
      { n: 6, name: "D-", kind: "bidirectional", alt: ["d-", "dm"] },
    ],
    symbolRef: "pinheader",
    electrical: { standard: "USB-C", current_max_a: 3 },
  }),
  part({
    id: "t0:dc_jack",
    category: "Connector",
    description: "Barrel DC power jack, 2.1mm",
    ftype: "simple_connector",
    pinList: [
      { n: 1, name: "VIN", kind: "power_out", alt: ["vin", "tip", "+"], fn: ["power_out"] },
      { n: 2, name: "GND", kind: "ground", alt: ["gnd", "sleeve", "-"], fn: ["ground"] },
    ],
    symbolRef: "pinheader",
    electrical: { barrel_id_mm: 2.1 },
  }),
  part({
    id: "t0:relay_spdt",
    category: "Electromechanical",
    description: "SPDT signal relay",
    ftype: "simple_switch",
    pinList: [
      { n: 1, name: "COIL+", kind: "passive", alt: ["coil+", "a1"] },
      { n: 2, name: "COIL-", kind: "passive", alt: ["coil-", "a2"] },
      { n: 3, name: "COM", kind: "passive", alt: ["com", "pole"] },
      { n: 4, name: "NO", kind: "passive", alt: ["no"] },
      { n: 5, name: "NC", kind: "passive", alt: ["nc"] },
    ],
    symbolRef: "spdt_switch",
  }),
  part({
    id: "t0:buzzer",
    category: "Audio",
    description: "Magnetic buzzer",
    ftype: "simple_connector",
    pinList: POLARISED,
    symbolRef: "pinheader",
  }),
  part({
    id: "t0:ldr",
    category: "Sensor",
    description: "Light-dependent resistor (photoresistor)",
    ftype: "simple_resistor",
    pinList: TWO_PIN_PASSIVE,
    symbolRef: "boxresistor_horz",
    footprinter: "0805",
  }),
  part({
    id: "t0:ntc",
    category: "Sensor",
    description: "NTC thermistor",
    ftype: "simple_resistor",
    pinList: TWO_PIN_PASSIVE,
    symbolRef: "boxresistor_horz",
    footprinter: "0603",
    electrical: { beta_k: 3950 },
  }),
]

/** The complete T0 catalog. */
export const T0_PARTS: PartDefinition[] = [
  ...passives,
  ...semiconductors,
  ...power,
  ...ics,
  ...electromechanical,
]

const BY_ID = new Map(T0_PARTS.map((p) => [p.id, p]))
const BY_MPN = new Map(
  T0_PARTS.filter((p) => p.mpn).map((p) => [(p.mpn as string).toLowerCase(), p]),
)

export const getT0Part = (idOrMpn: string): PartDefinition | undefined =>
  BY_ID.get(idOrMpn) ?? BY_MPN.get(idOrMpn.toLowerCase())

/** The categories present in T0, for the palette's facet list. */
export const T0_CATEGORIES = [...new Set(T0_PARTS.map((p) => p.category))].sort()
