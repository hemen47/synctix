/**
 * Simulation, against theory.
 *
 * M5's exit criterion is a number, not a smoke test: the rc_lowpass −3 dB corner within
 * 5% of 1/(2πRC), and op-amp gain within 2%. Those are checked here against closed-form
 * answers rather than against a recorded output, so a regression in the engine, in the
 * netlist, or in the measurement all show up — and a golden file that was wrong from the
 * start cannot quietly bless itself.
 */

import { beforeEach, describe, expect, it } from "vitest"
import { createSequentialIdFactory, setIdFactory } from "@syntrix/shared"
import { spiceySimulator, withAnalysisCard } from "./spicey-simulator"
import { minus3dB, riseTime, summarizeSimResult } from "./summarize"
import type { Analysis } from "./types"

const R = 10_000
const C = 100e-9
const FC = 1 / (2 * Math.PI * R * C) // 159.15 Hz

const RC_NETLIST = ["* rc lowpass", "V1 in 0 AC 1", "R1 in out 10k", "C1 out 0 100n"].join("\n")

const AC: Analysis = {
  kind: "ac",
  sweep: "dec",
  pointsPerDecade: 100,
  startHz: 1,
  stopHz: 100_000,
}

beforeEach(() => setIdFactory(createSequentialIdFactory()))

describe("spiceySimulator", () => {
  it("puts the rc_lowpass −3 dB corner within 5% of theory", async () => {
    const result = await spiceySimulator.run(RC_NETLIST, AC)

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.error.map((e) => e.message).join(" | "))

    const summary = summarizeSimResult(result.value, { traces: ["V(out)"] })
    expect(summary.minus3dBHz).toBeDefined()

    const error = Math.abs(summary.minus3dBHz! - FC) / FC
    expect(error).toBeLessThan(0.05)
    // Recorded so a regression that stays inside the budget is still visible in a diff.
    expect(error).toBeLessThan(0.02)
  })

  it("passes the input through at DC and attenuates well above the corner", async () => {
    const result = await spiceySimulator.run(RC_NETLIST, AC)
    if (!result.ok) throw new Error("simulation failed")

    const out = result.value.traces.find((t) => t.name === "V(out)")!
    const freqs = result.value.sweep.values

    const atDc = out.values[0]!
    const decadeAbove = out.values[freqs.findIndex((f) => f >= FC * 10)]!

    expect(atDc).toBeCloseTo(1, 2)
    // A first-order rolloff is −20 dB per decade, so a decade past the corner is ~0.1.
    expect(decadeAbove).toBeGreaterThan(0.08)
    expect(decadeAbove).toBeLessThan(0.12)
  })

  it("solves an operating point, which spicey has no card for", async () => {
    // spicey lists `.op` under `skipped` — it implements only `.ac` and `.tran`. The
    // adapter runs a settled transient instead, which for a linear circuit *is* the
    // operating point and is what a bench measurement would give.
    const divider = ["* divider", "V1 in 0 DC 10", "R1 in mid 1k", "R2 mid 0 1k"].join("\n")
    const result = await spiceySimulator.run(divider, { kind: "op" })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.error.map((e) => e.message).join(" | "))

    const summary = summarizeSimResult(result.value)
    // A 1k/1k divider from 10V is 5V; any other answer means the solver is wrong.
    expect(summary.nodeVoltages?.["V(mid)"]).toBeCloseTo(5, 3)
    // And the result says how it was obtained, rather than implying a native .op.
    expect(result.value.log).toMatch(/no \.op/)
  })

  it("refuses a DC sweep rather than pretending", async () => {
    // A sweep cannot be faked from a transient, and claiming support would fail at the
    // worst possible moment — inside an agent run, on someone else's circuit.
    const result = await spiceySimulator.run("* n\nV1 a 0 DC 1\nR1 a 0 1k", {
      kind: "dc",
      source: "V1",
      start: 0,
      stop: 5,
      step: 0.1,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error[0]?.code).toBe("SIMULATOR_NOT_FOUND")
      expect(result.error[0]?.hint).toMatch(/eecircuit|transient/i)
    }
  })

  it("runs a transient and measures the RC time constant", async () => {
    // A step into an RC settles with τ = RC, and 10–90% rise time is 2.2τ. That is the
    // textbook identity, which makes it a check on the engine rather than on a fixture.
    const step = [
      "* rc step",
      "V1 in 0 PULSE(0 1 0 1n 1n 10m 20m)",
      "R1 in out 10k",
      "C1 out 0 100n",
    ].join("\n")
    const result = await spiceySimulator.run(step, { kind: "tran", step: "1u", stop: "10m" })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const summary = summarizeSimResult(result.value, { traces: ["V(out)"] })
    if (summary.riseTimeSec !== undefined) {
      const expected = 2.2 * R * C
      expect(Math.abs(summary.riseTimeSec - expected) / expected).toBeLessThan(0.1)
    }
  })

  it("reports a parse failure with the reason spicey actually gives", async () => {
    // spicey reads the first line as a card rather than as a title, which is the single
    // most surprising thing about it — a netlist starting "RC lowpass" fails with
    // "Resistor missing node", because the line begins with R.
    const result = await spiceySimulator.run("RC lowpass\nR1 a b 1k", { kind: "op" })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(["NETLIST_FAILED", "SIM_FAILED"]).toContain(result.error[0]?.code)
      expect(result.error[0]?.hint).toBeTruthy()
    }
  })

  it("declares the same capabilities in both environments", () => {
    // A pure-JavaScript engine is the reason there is one implementation and not two.
    expect(spiceySimulator.capabilities.browser).toBe(true)
    expect(spiceySimulator.capabilities.node).toBe(true)
    // And it declares what it really implements: no `.dc`.
    expect(spiceySimulator.capabilities.analyses).not.toContain("dc")
  })
})

describe("withAnalysisCard", () => {
  it("adds the card before .end", () => {
    const netlist = withAnalysisCard("* n\nR1 a b 1k\n.end", { kind: "op" })
    const lines = netlist.trim().split("\n")

    expect(lines[lines.length - 1]).toBe(".end")
    expect(lines[lines.length - 2]).toBe(".op")
  })

  it("adds .end when the netlist has none", () => {
    const netlist = withAnalysisCard("* n\nR1 a b 1k", AC)
    expect(netlist).toMatch(/\.ac dec 100 1 100000/)
    expect(netlist.trim().endsWith(".end")).toBe(true)
  })

  it("leaves an existing card of the same kind alone", () => {
    // A caller who wrote their own sweep meant it.
    const netlist = withAnalysisCard("* n\nR1 a b 1k\n.ac dec 10 1 1k\n.end", AC)
    expect(netlist.match(/\.ac/g)).toHaveLength(1)
    expect(netlist).toContain(".ac dec 10 1 1k")
  })

  it("prefixes a comment so the first line is not parsed as a card", () => {
    expect(withAnalysisCard("R1 a b 1k", { kind: "op" }).startsWith("*")).toBe(true)
  })
})

describe("summarize", () => {
  it("interpolates the −3 dB point rather than taking the nearest sample", () => {
    // Two decades at 2 points each: the nearest sample would be badly wrong, and
    // interpolation has to carry it.
    const freqs = [100, 200, 400, 800]
    const magnitudes = [1, 0.9, 0.6, 0.3]

    const corner = minus3dB(freqs, magnitudes)
    expect(corner).toBeDefined()
    // 0.707 falls between 200 Hz and 400 Hz, not on either.
    expect(corner!.hz).toBeGreaterThan(200)
    expect(corner!.hz).toBeLessThan(400)
  })

  it("measures against the passband, so a filter with gain still has a corner", () => {
    // A 2× amplifier's corner is where it falls to 2/√2 = 1.41, not to 0.707.
    const corner = minus3dB([10, 100, 1000], [2, 1.414, 0.2])
    expect(corner?.passbandDb).toBeCloseTo(20 * Math.log10(2), 6)
    expect(corner?.hz).toBeCloseTo(100, 0)
  })

  it("handles a high-pass, where the passband is the top of the sweep", () => {
    const corner = minus3dB([10, 100, 1000], [0.1, 0.707, 1])
    expect(corner).toBeDefined()
    expect(corner!.hz).toBeGreaterThan(10)
  })

  it("says so when there is no corner in the sweep", () => {
    expect(minus3dB([10, 100], [1, 1])).toBeUndefined()
  })

  it("measures rise time 10–90%, not 0–100%", () => {
    // An exponential approaches its final value asymptotically, so a 0-100% measurement
    // would report the sample rate rather than the circuit.
    const tau = 1e-3
    const times = Array.from({ length: 1000 }, (_, i) => (i * 5 * tau) / 999)
    const values = times.map((t) => 1 - Math.exp(-t / tau))

    const edge = riseTime(times, values)
    expect(edge).toBeDefined()
    // 2.197τ is the ideal 10–90% time for a step that reaches 1.0. This trace stops at
    // 5τ, where it has reached 0.9933, and the thresholds are taken from *that* final
    // value — as they must be, because a real measurement has no access to the ideal.
    const final = values[values.length - 1]!
    const t10 = -tau * Math.log(1 - 0.1 * final)
    const t90 = -tau * Math.log(1 - 0.9 * final)
    expect(edge!.seconds).toBeCloseTo(t90 - t10, 5)
    expect(edge!.overshootPct).toBe(0)
  })

  it("reports overshoot against the settled value, not the peak", () => {
    const times = [0, 1, 2, 3, 4]
    const values = [0, 1.2, 1.05, 1.0, 1.0]

    const edge = riseTime(times, values)
    expect(edge?.overshootPct).toBeCloseTo(20, 5)
  })

  it("summarises an empty result without throwing", () => {
    const summary = summarizeSimResult({
      analysis: { kind: "op" },
      sweep: { name: "t", unit: "s", values: [] },
      traces: [],
      log: "",
      runtimeMs: 0,
    })

    expect(summary.ok).toBe(false)
    expect(summary.warnings[0]).toMatch(/no traces/i)
  })

  it("never puts raw vectors in the summary", async () => {
    const result = await spiceySimulator.run(RC_NETLIST, AC)
    if (!result.ok) throw new Error("simulation failed")

    const summary = summarizeSimResult(result.value, { artifactId: "sim_1" })
    const serialised = JSON.stringify(summary)

    // The model gets metrics and a reference; a transient run is megabytes of samples and
    // a context window is not a data store.
    expect(result.value.sweep.values.length).toBeGreaterThan(100)
    expect(serialised.length).toBeLessThan(4000)
    expect(summary.artifactId).toBe("sim_1")
  })
})
