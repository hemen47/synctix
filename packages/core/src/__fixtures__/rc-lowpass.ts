/**
 * Golden fixture: an RC low-pass filter.
 *
 * VIN -- R1(10k) --+-- VOUT
 *                  |
 *                C1(100nF)
 *                  |
 *                 GND
 *
 * -3 dB at 1 / (2·π·R·C) = 159.155 Hz, which M6 verifies against a simulation to within
 * 5%. Defined as operations rather than as a circuit-json blob so that the fixture
 * exercises the same path the agent and the UI use — building it *is* the round-trip
 * test.
 */

import type { Operation } from "../operations"

export const RC_LOWPASS_R = 10_000
export const RC_LOWPASS_C = 100e-9

/** Theoretical -3 dB corner, in hertz. */
export const RC_LOWPASS_FC = 1 / (2 * Math.PI * RC_LOWPASS_R * RC_LOWPASS_C)

export const rcLowpassOperations: Operation[] = [
  { type: "add_component", ftype: "simple_resistor", name: "R1", props: { resistance: "10k" } },
  {
    type: "add_component",
    ftype: "simple_capacitor",
    name: "C1",
    props: { capacitance: "100nF" },
  },
  { type: "create_net", name: "VIN", isPower: false, isGround: false },
  { type: "create_net", name: "VOUT", isPower: false, isGround: false },
  { type: "create_net", name: "GND", isPower: false, isGround: true },
  { type: "connect", a: { component: "R1", pin: 1 }, b: { net: "VIN" } },
  { type: "connect", a: { component: "R1", pin: 2 }, b: { net: "VOUT" } },
  { type: "connect", a: { component: "C1", pin: 1 }, b: { net: "VOUT" } },
  { type: "connect", a: { component: "C1", pin: 2 }, b: { net: "GND" } },
]

/** The same circuit as a single atomic batch — one undo step. */
export const rcLowpassBatch: Operation = {
  type: "batch",
  ops: rcLowpassOperations,
  atomic: true,
}
