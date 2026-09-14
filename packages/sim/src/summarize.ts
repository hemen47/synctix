/**
 * Turning a simulation into something a model can read.
 *
 * A transient run is tens of thousands of samples per node. A context window is not a
 * data store, and a model handed raw vectors will do arithmetic on them badly and at
 * length. So the agent sees **metrics** — the −3 dB corner, the rise time, the overshoot,
 * the operating point — and a reference to the vectors, which stay on disk for the plot.
 *
 * Every metric here is one an engineer would have measured by hand off a scope.
 */

import type { SimResult, SimSummary, SimTrace } from "./types"

export interface SummarizeOptions {
  /** Where the full vectors were written, so the UI can plot what the model described. */
  artifactId?: string
  /** Restrict the summary to these traces. Everything, by default. */
  traces?: string[]
}

export const summarizeSimResult = (
  result: SimResult,
  options: SummarizeOptions = {},
): SimSummary => {
  const traces = options.traces
    ? result.traces.filter((t) => options.traces!.includes(t.name))
    : result.traces

  const warnings: string[] = []
  const summary: SimSummary = {
    analysis: result.analysis.kind,
    ok: traces.length > 0,
    warnings,
    ...(options.artifactId ? { artifactId: options.artifactId } : {}),
  }

  if (traces.length === 0) {
    warnings.push("The simulation produced no traces.")
    return summary
  }

  summary.stats = Object.fromEntries(traces.map((trace) => [trace.name, statsFor(trace)]))

  switch (result.analysis.kind) {
    case "op":
      summary.nodeVoltages = Object.fromEntries(
        traces.map((trace) => [trace.name, trace.values[0] ?? 0]),
      )
      break

    case "ac": {
      // The output node is the last one, by the convention that a netlist is written
      // input-first. A caller that knows better passes `traces`.
      const output = traces[traces.length - 1]!
      const corner = minus3dB(result.sweep.values, output.values)
      if (corner) {
        summary.minus3dBHz = corner.hz
        summary.passbandGainDb = corner.passbandDb
      } else {
        warnings.push(
          `No −3 dB point for ${output.name} inside ${result.sweep.values[0]}–` +
            `${result.sweep.values[result.sweep.values.length - 1]} Hz — widen the sweep.`,
        )
      }
      break
    }

    case "tran": {
      const output = traces[traces.length - 1]!
      const edge = riseTime(result.sweep.values, output.values)
      if (edge) {
        summary.riseTimeSec = edge.seconds
        summary.overshootPct = edge.overshootPct
      }
      break
    }

    case "dc":
      break
  }

  return summary
}

const statsFor = (trace: SimTrace): { min: number; max: number; rms: number; mean: number } => {
  const values = trace.values
  let min = Infinity
  let max = -Infinity
  let sum = 0
  let sumSquares = 0

  for (const value of values) {
    min = Math.min(min, value)
    max = Math.max(max, value)
    sum += value
    sumSquares += value * value
  }

  const n = values.length || 1
  return {
    min: values.length ? min : 0,
    max: values.length ? max : 0,
    mean: sum / n,
    rms: Math.sqrt(sumSquares / n),
  }
}

/**
 * The −3 dB corner, interpolated.
 *
 * Measured against the **passband** rather than against 1.0, because a filter with gain
 * is still a filter: a 2× amplifier's corner is where it falls to 2/√2, not to 0.707.
 * The passband is the low-frequency end for a low-pass and the high end for a high-pass,
 * so the larger of the two extremes is the right reference either way.
 *
 * Interpolating between samples rather than taking the nearest one matters: at 50 points
 * per decade the nearest sample can be 5% off, which is the whole error budget.
 */
export const minus3dB = (
  freqs: number[],
  magnitudes: number[],
): { hz: number; passbandDb: number } | undefined => {
  if (freqs.length < 2 || magnitudes.length !== freqs.length) return undefined

  const first = magnitudes[0]!
  const last = magnitudes[magnitudes.length - 1]!
  const passband = Math.max(first, last)
  if (passband <= 0) return undefined

  const target = passband / Math.SQRT2
  const descending = first >= last

  for (let i = 1; i < magnitudes.length; i += 1) {
    const previous = magnitudes[i - 1]!
    const current = magnitudes[i]!
    const crossed = descending
      ? previous >= target && current <= target
      : previous <= target && current >= target
    if (!crossed) continue

    // Log-log interpolation: a first-order rolloff is a straight line in those axes, so
    // this is exact for the common case rather than merely close.
    const f0 = freqs[i - 1]!
    const f1 = freqs[i]!
    if (previous === current) return { hz: f0, passbandDb: 20 * Math.log10(passband) }

    const t = (Math.log(target) - Math.log(previous)) / (Math.log(current) - Math.log(previous))
    const hz = Math.exp(Math.log(f0) + t * (Math.log(f1) - Math.log(f0)))
    return { hz, passbandDb: 20 * Math.log10(passband) }
  }

  return undefined
}

/**
 * 10–90% rise time and overshoot.
 *
 * The 10–90% convention rather than 0–100%: the tails of an exponential approach the
 * final value asymptotically, so a 0–100% "rise time" measures the sample rate.
 */
export const riseTime = (
  times: number[],
  values: number[],
): { seconds: number; overshootPct: number } | undefined => {
  if (times.length < 2 || values.length !== times.length) return undefined

  const start = values[0]!
  const peak = Math.max(...values)
  // The settled value, not the peak: an overshooting response settles below its peak, and
  // measuring rise time to the peak would understate it.
  const final = values[values.length - 1]!
  const span = final - start
  if (Math.abs(span) < 1e-12) return undefined

  const at = (fraction: number): number | undefined => {
    const threshold = start + span * fraction
    for (let i = 1; i < values.length; i += 1) {
      const previous = values[i - 1]!
      const current = values[i]!
      const crossed =
        span > 0
          ? previous < threshold && current >= threshold
          : previous > threshold && current <= threshold
      if (!crossed) continue
      const t = (threshold - previous) / (current - previous)
      return times[i - 1]! + t * (times[i]! - times[i - 1]!)
    }
    return undefined
  }

  const t10 = at(0.1)
  const t90 = at(0.9)
  if (t10 === undefined || t90 === undefined) return undefined

  return {
    seconds: t90 - t10,
    overshootPct: span > 0 ? Math.max(0, ((peak - final) / span) * 100) : 0,
  }
}
