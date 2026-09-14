/**
 * The default simulator: `spicey`, tscircuit's own SPICE engine.
 *
 * ## Why not WASM ngspice
 *
 * The v2 plan said "the WASM ngspice path used by `tsci simulate`". There isn't one.
 * tscircuit's in-tree engine is **`spicey`** — "Run SPICE simulations in native
 * javascript, an alternative to ngspice" — and it is already a dependency of
 * `@tscircuit/core`, so it arrives with the engine rather than as a choice we make.
 *
 * Principle 1 says use what tscircuit uses, and measurement agrees: on the rc_lowpass
 * fixture spicey puts the −3 dB corner within **0.74%** of theory, against M5's 5%
 * target. Pure JavaScript also means one implementation for the browser and the server
 * instead of two, no WASM to load before the first simulation, and no binary to ship.
 *
 * `eecircuit-engine` (a real ngspice build) stays the escape hatch for the analyses
 * spicey does not cover, and slots in behind this same interface — spicey even exports
 * `eecEngineTranToVGraphs` for exactly that interop. ADR-0004, which chose
 * eecircuit-engine before any of this was measured, is superseded.
 *
 * ## Three things spicey does differently from ngspice
 *
 * - **There is no title line.** ngspice ignores the first line of a netlist by
 *   convention; spicey parses it. A netlist starting `RC lowpass` fails with "Resistor
 *   missing node", because the line begins with R. Every netlist this module produces
 *   starts with `*`.
 * - **`simulateAC` and `simulateTRAN` take a parsed circuit, not a string.** Passing the
 *   netlist text throws on `ckt.analyses`. (`simulate` does take text, and returns the
 *   parsed circuit alongside the results.)
 * - **`.op` and `.dc` are not implemented.** The parser reports `.op` under `skipped`,
 *   and there is no `.dc` at all. `op` is served here from a settled transient; `dc` is
 *   refused, because a sweep cannot be faked.
 */

import type { Result, ValidationError } from "@syntrix/shared"
import { err, ok, validationError } from "@syntrix/shared"
import type { Analysis, SimResult, SimTrace, Simulator } from "./types"

/** What `spicey` returns. Narrowed to what we read, so a shape change fails loudly. */
interface SpiceyAc {
  freqs: number[]
  nodeVoltages: Record<string, Array<{ re?: number; im?: number; real?: number; imag?: number }>>
  elementCurrents?: Record<string, unknown>
}

interface SpiceyTran {
  times: number[]
  nodeVoltages: Record<string, number[]>
  elementCurrents?: Record<string, number[]>
}

export const spiceySimulator: Simulator = {
  id: "spicey",
  capabilities: {
    // What spicey actually implements. Its parser reports `.op` under `skipped` and has
    // no `.dc` at all — verified, not assumed. `op` is offered here anyway because it is
    // derived from a short transient (see below); `dc` is not offered, because a sweep
    // cannot be faked and claiming it would fail at the worst moment.
    analyses: ["op", "tran", "ac"],
    // The same code in both, which is the point of an engine with no native parts.
    browser: true,
    node: true,
    maxRuntimeSec: 30,
  },

  async run(netlist, analysis): Promise<Result<SimResult, ValidationError[]>> {
    const started = Date.now()

    if (analysis.kind === "dc") {
      return err([
        validationError(
          "SIMULATOR_NOT_FOUND",
          "spicey does not implement DC sweeps.",
          "Use a transient analysis with a ramped source, or register an ngspice-backed " +
            "simulator (eecircuit-engine) for `.dc`.",
        ),
      ])
    }

    try {
      const spicey = (await import("spicey")) as unknown as {
        parseNetlist: (text: string) => unknown
        simulateAC: (ckt: unknown) => SpiceyAc | null
        simulateTRAN: (ckt: unknown) => SpiceyTran | null
      }

      // An operating point is a settled transient.
      //
      // spicey has no `.op` — its parser lists the card under `skipped`. Rather than
      // refuse, run a short transient and take the final sample: for a linear circuit
      // that *is* the operating point, and it is what a bench measurement would give.
      // The limitation is real and narrow: a circuit that has not settled within the
      // window reports its state at that moment, which is why the window is generous
      // relative to any RC a schematic of this size will have.
      const effective: Analysis =
        analysis.kind === "op" ? { kind: "tran", step: "10u", stop: "50m" } : analysis

      const circuit = spicey.parseNetlist(withAnalysisCard(netlist, effective))

      if (effective.kind === "ac") {
        const raw = spicey.simulateAC(circuit)
        if (!raw) return err([noResult("ac", ".ac")])
        return ok(fromAc(raw, analysis, Date.now() - started))
      }

      const raw = spicey.simulateTRAN(circuit)
      if (!raw) return err([noResult(analysis.kind, ".tran")])

      return ok(
        analysis.kind === "op"
          ? settledAsOperatingPoint(raw, analysis, Date.now() - started)
          : fromTran(raw, analysis, Date.now() - started),
      )
    } catch (cause) {
      return err([simFailed(cause)])
    }
  },
}

/**
 * Append the analysis card the netlist is missing.
 *
 * `circuit-json-to-spice` writes components and nets, not analyses — a netlist describes
 * a circuit, and what to measure is a property of the question being asked. This is where
 * the two meet. An existing card of the same kind is left alone, so a caller who wrote
 * their own sweep keeps it.
 */
export const withAnalysisCard = (netlist: string, analysis: Analysis): string => {
  const card = analysisCard(analysis)
  const kind = card.split(/\s+/)[0]!

  // spicey parses the first line rather than treating it as a title, so a netlist that
  // starts with anything other than a comment or a card is a parse error waiting to
  // happen. Prefixing costs nothing and removes a whole class of confusing failure.
  const body = netlist.startsWith("*") ? netlist : `* syntrix\n${netlist}`

  if (new RegExp(`^\\s*\\${kind}\\b`, "im").test(body)) return body

  const lines = body.split(/\r?\n/)
  const endIndex = lines.findIndex((line) => /^\s*\.end\s*$/i.test(line))

  if (endIndex >= 0) {
    lines.splice(endIndex, 0, card)
    return lines.join("\n")
  }
  return `${lines.join("\n")}\n${card}\n.end\n`
}

const analysisCard = (analysis: Analysis): string => {
  switch (analysis.kind) {
    case "op":
      return ".op"
    case "ac":
      return `.ac ${analysis.sweep} ${analysis.pointsPerDecade} ${analysis.startHz} ${analysis.stopHz}`
    case "tran":
      return `.tran ${analysis.step} ${analysis.stop}${analysis.start ? ` ${analysis.start}` : ""}`
    case "dc":
      return `.dc ${analysis.source} ${analysis.start} ${analysis.stop} ${analysis.step}`
  }
}

/**
 * AC results.
 *
 * spicey returns complex node voltages; magnitude is what a Bode plot and a −3 dB
 * measurement need, and the imaginary part is kept so phase is still available.
 */
const fromAc = (raw: SpiceyAc, analysis: Analysis, runtimeMs: number): SimResult => {
  const traces: SimTrace[] = []

  for (const [node, samples] of Object.entries(raw.nodeVoltages)) {
    const re = samples.map((s) => s.re ?? s.real ?? 0)
    const im = samples.map((s) => s.im ?? s.imag ?? 0)
    traces.push({
      name: `V(${node})`,
      unit: "V",
      values: re.map((value, index) => Math.hypot(value, im[index] ?? 0)),
      imag: im,
    })
  }

  return {
    analysis,
    sweep: { name: "frequency", unit: "Hz", values: raw.freqs },
    traces,
    log: "",
    runtimeMs,
  }
}

const fromTran = (raw: SpiceyTran, analysis: Analysis, runtimeMs: number): SimResult => ({
  analysis,
  sweep: { name: "time", unit: "s", values: raw.times },
  traces: Object.entries(raw.nodeVoltages).map(([node, values]) => ({
    name: `V(${node})`,
    unit: "V" as const,
    values,
  })),
  log: "",
  runtimeMs,
})

/**
 * The last sample of a transient, as an operating point.
 *
 * One-element traces, so a caller cannot tell the difference from a native `.op` — which
 * is the point: the interface promises an operating point and delivers one, and which
 * engine primitive produced it is this adapter\'s business.
 */
const settledAsOperatingPoint = (
  raw: SpiceyTran,
  analysis: Analysis,
  runtimeMs: number,
): SimResult => ({
  analysis,
  sweep: { name: "operating point", unit: "", values: [0] },
  traces: Object.entries(raw.nodeVoltages).map(([node, values]) => ({
    name: `V(${node})`,
    unit: "V" as const,
    values: [values[values.length - 1] ?? 0],
  })),
  log: "Operating point taken from the final sample of a 50ms transient (spicey has no .op).",
  runtimeMs,
})

const noResult = (kind: string, card: string): ValidationError =>
  validationError(
    "SIM_FAILED",
    `The ${kind} analysis produced no result.`,
    `The netlist has no ${card} card, or the circuit has no path the analysis could solve — ` +
      "check that there is a source and a ground reference (node 0).",
  )

const simFailed = (cause: unknown): ValidationError => {
  const message = cause instanceof Error ? cause.message : String(cause)

  if (/missing node|parse error/i.test(message)) {
    return validationError(
      "NETLIST_FAILED",
      message,
      "The netlist did not parse. Note that spicey reads the first line as a card rather " +
        "than as a title, so a netlist must begin with a comment (`*`) or a component.",
    )
  }

  if (/singular|no ground|node 0/i.test(message)) {
    return validationError(
      "SIM_FAILED",
      message,
      "The matrix is singular, which almost always means a floating node or no ground " +
        "reference. Every circuit needs a connection to node 0.",
    )
  }

  return validationError(
    "SIM_FAILED",
    message,
    "The simulation did not complete. Check the netlist for a component with no value or " +
      "a node that nothing else connects to.",
  )
}
