/**
 * Simulator plugin contract.
 *
 * Two implementations share it: ngspice compiled to WASM (Web Worker in the browser,
 * worker thread in Node) for interactive analyses, and the native ngspice in the `sim`
 * container for long jobs. Same interface; the caller picks by capability and job size.
 */

import type { Result, ValidationError } from "@syntrix/shared"

export type AnalysisKind = "op" | "tran" | "ac" | "dc"

export type Analysis =
  | { kind: "op" }
  | { kind: "tran"; step: string; stop: string; start?: string; maxStep?: string }
  | {
      kind: "ac"
      sweep: "dec" | "oct" | "lin"
      pointsPerDecade: number
      startHz: number
      stopHz: number
    }
  | { kind: "dc"; source: string; start: number; stop: number; step: number }

export interface SimCapabilities {
  analyses: AnalysisKind[]
  /** True when the simulator can run in the browser. */
  browser: boolean
  node: boolean
  /** Soft ceiling in seconds; the caller routes longer jobs to the remote simulator. */
  maxRuntimeSec: number
}

/** Raw output. Vectors go to object storage; the LLM never sees this shape. */
export interface SimResult {
  analysis: Analysis
  /** Independent variable — time, frequency, or sweep value. */
  sweep: { name: string; unit: string; values: number[] }
  /** One entry per probed node or branch current. */
  traces: SimTrace[]
  log: string
  runtimeMs: number
}

export interface SimTrace {
  name: string
  unit: "V" | "A" | "dB" | "deg"
  values: number[]
  /** AC analysis produces complex results; imaginary part lives here. */
  imag?: number[]
}

/**
 * What the LLM actually receives. A transient run is megabytes of samples and a context
 * window is not a data store, so the model gets metrics and a storage reference.
 */
export interface SimSummary {
  analysis: AnalysisKind
  ok: boolean
  /** DC operating point, node name to volts. */
  nodeVoltages?: Record<string, number>
  /** Per-trace statistics. */
  stats?: Record<string, { min: number; max: number; rms?: number; mean?: number }>
  /** AC only: -3 dB corner in Hz, and gain at the passband. */
  minus3dBHz?: number
  passbandGainDb?: number
  /** Transient only. */
  riseTimeSec?: number
  overshootPct?: number
  /** Object-storage id of the full vectors. */
  artifactId?: string
  warnings: string[]
}

export interface Simulator {
  id: string
  capabilities: SimCapabilities
  run(netlist: string, analysis: Analysis): Promise<Result<SimResult, ValidationError[]>>
}

export interface SimulatorRegistry {
  register(sim: Simulator): void
  get(id: string): Simulator | undefined
  list(): Simulator[]
  /** Pick a simulator that supports the analysis in the current environment. */
  select(analysis: Analysis, env: "browser" | "node"): Simulator | undefined
}
