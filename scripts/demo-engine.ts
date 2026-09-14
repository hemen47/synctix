/**
 * A guided tour of what the engine does today (M0–M2).
 *
 *   pnpm demo
 *
 * Everything here goes through the same `apply()` path the web UI, REST API, agent and
 * MCP server will use — there is no demo-only shortcut.
 */

import {
  apply,
  applyAll,
  buildIndex,
  createDesign,
  electricalNets,
  formatErcForLlm,
  resolvePort,
  runErc,
  summarizeForLLM,
  validateCircuit,
} from "@syntrix/core"
import type { Design, Operation } from "@syntrix/core"
import {
  T0_PARTS,
  createDefaultRegistry,
  federatedSearch,
  resolveFootprint,
  searchParts,
  t0Resolver,
} from "@syntrix/parts"

const ctx = { resolvePart: t0Resolver }

const rule = (title: string) => {
  console.log(`\n\x1b[36m${"─".repeat(72)}\x1b[0m`)
  console.log(`\x1b[36m▍${title}\x1b[0m`)
  console.log(`\x1b[36m${"─".repeat(72)}\x1b[0m`)
}

const must = (design: Design, ops: Operation[]): Design => {
  const result = applyAll(design, ops, ctx)
  if (!result.ok) {
    console.error("unexpected failure:", result.error)
    process.exit(1)
  }
  return result.value
}

// ---------------------------------------------------------------- 1. parts search
rule("1. Parts search — the M2 exit criterion")

console.log(`T0 catalog: ${T0_PARTS.length} parts, no network or database needed.\n`)
console.log(`Query: "3.3V LDO SOT-223"\n`)

for (const [i, scored] of searchParts(T0_PARTS, "3.3V LDO SOT-223").slice(0, 4).entries()) {
  const p = scored.part
  const badge =
    p.footprint.verification === "verified"
      ? "\x1b[32m✓ verified\x1b[0m"
      : "\x1b[33m? unverified\x1b[0m"
  console.log(
    `  ${i + 1}. ${(p.mpn ?? p.id).padEnd(16)} ${String(p.footprint.jedecPackage ?? "—").padEnd(10)} ${badge}  score ${scored.score.toFixed(0)}`,
  )
  console.log(`     ${p.description}`)
}

// The verification flag is only meaningful if the geometry actually resolves.
const ams = searchParts(T0_PARTS, "3.3V LDO SOT-223")[0]!.part
const footprint = resolveFootprint(ams.footprint)
console.log(
  `\n  Footprint check: ${ams.footprint.footprinterString} -> ${
    footprint.ok
      ? `${footprint.value.padCount} pads, resolved by ${footprint.value.resolvedBy}`
      : "FAILED"
  }`,
)

// ---------------------------------------------------------------- 2. build a circuit
rule("2. Build an AMS1117 regulator — every change is an Operation")

let design = createDesign("demo-regulator")

design = must(design, [
  { type: "add_component", partRef: "t0:ams1117-3.3", name: "U1", props: {} },
  { type: "add_component", partRef: "t0:capacitor", name: "C1", props: { capacitance: "10uF" } },
  { type: "add_component", partRef: "t0:capacitor", name: "C2", props: { capacitance: "22uF" } },
  { type: "create_net", name: "VIN", isPower: true, isGround: false },
  { type: "create_net", name: "+3V3", isPower: true, isGround: false },
  { type: "create_net", name: "GND", isPower: false, isGround: true },

  // Pins are addressed by their datasheet names, not by number — this is what
  // port_hints buys us, and what lets the agent work from a datasheet.
  { type: "connect", a: { component: "U1", pin: "VIN" }, b: { net: "VIN" } },
  { type: "connect", a: { component: "U1", pin: "VOUT" }, b: { net: "+3V3" } },
  { type: "connect", a: { component: "U1", pin: "GND" }, b: { net: "GND" } },
  { type: "connect", a: { component: "U1", pin: "TAB" }, b: { net: "+3V3" } },

  { type: "connect", a: { component: "C1", pin: 1 }, b: { net: "VIN" } },
  { type: "connect", a: { component: "C1", pin: 2 }, b: { net: "GND" } },
  { type: "connect", a: { component: "C2", pin: 1 }, b: { net: "+3V3" } },
  { type: "connect", a: { component: "C2", pin: 2 }, b: { net: "GND" } },

  // The LLM never emits coordinates. It says what it means; layout (M3) decides where.
  {
    type: "place_hint",
    component: "C2",
    constraints: [{ kind: "decoupling_for", component: "U1", pin: "VOUT" }],
  },
])

const view = buildIndex(design.circuit)
console.log(`Applied 14 operations -> version ${design.version}`)
console.log(
  `  ${view.components.size} components, ${view.ports.size} pins, ${view.traces.size} traces`,
)
console.log(`  ${electricalNets(view).length} electrical nets`)

console.log("\n  Pin resolution by datasheet name:")
for (const pin of ["VIN", "VOUT", "GND", "TAB"]) {
  const port = resolvePort(view, { component: "U1", pin })
  console.log(`    U1."${pin.padEnd(4)}" -> physical pin ${port?.pin_number}`)
}

// ---------------------------------------------------------------- 3. conformance
rule("3. Spec conformance — principle 2")

const conformance = validateCircuit(design.circuit)
console.log(
  conformance.ok
    ? `\x1b[32m✓\x1b[0m All ${design.circuit.length} elements are valid circuit-json.`
    : `\x1b[31m✗\x1b[0m ${conformance.error.length} invalid element(s).`,
)
console.log(`  The placement hint lives in the meta sidecar, never in the element array:`)
const hinted = Object.entries(design.meta).find(([, m]) => m.constraints?.length)
console.log(`    meta[${hinted?.[0]}] = ${JSON.stringify(hinted?.[1].constraints)}`)

// ---------------------------------------------------------------- 4. ERC
rule("4. ERC")

console.log(formatErcForLlm(runErc(design)))

// ---------------------------------------------------------------- 5. errors are hints
rule("5. A rejected operation is data the model can act on")

const mistakes: Array<[string, Operation]> = [
  [
    "a pin that does not exist",
    { type: "connect", a: { component: "U1", pin: "VDD" }, b: { net: "GND" } },
  ],
  [
    "a component that does not exist",
    { type: "connect", a: { component: "U9", pin: 1 }, b: { net: "GND" } },
  ],
  [
    "a value that cannot be parsed",
    { type: "set_prop", component: "C1", key: "capacitance", value: "ten" },
  ],
  [
    "a duplicate refdes",
    { type: "add_component", ftype: "simple_resistor", name: "C1", props: {} },
  ],
]

for (const [label, op] of mistakes) {
  const result = apply(design, op, ctx)
  if (result.ok) {
    console.log(`\n  ${label}: unexpectedly succeeded`)
    continue
  }
  const e = result.error[0]!
  console.log(`\n  \x1b[33m${label}\x1b[0m`)
  console.log(`    code: ${e.code}`)
  console.log(`    ${e.message}`)
  console.log(`    \x1b[32mhint:\x1b[0m ${e.hint}`)
}

// ---------------------------------------------------------------- 6. ERC catches design faults
rule("6. ERC on a circuit with real faults")

let broken = createDesign("demo-broken")
broken = must(broken, [
  { type: "add_component", ftype: "simple_resistor", name: "R1", props: {} }, // no value
  { type: "add_component", ftype: "simple_capacitor", name: "C1", props: { capacitance: "1uF" } },
  { type: "connect", a: { component: "R1", pin: 2 }, b: { component: "C1", pin: 1 } },
])
console.log(formatErcForLlm(runErc(broken)))

// ---------------------------------------------------------------- 7. the LLM's view
rule("7. What the LLM actually sees — no coordinates, ever")

console.log(summarizeForLLM(design, { includeMeta: true }))

// ---------------------------------------------------------------- 8. undo
rule("8. Undo is a replay, not a special mechanism")

const beforeRemoval = design
const afterRemoval = apply(design, { type: "remove_component", component: "C2" }, ctx)
if (afterRemoval.ok) {
  const after = buildIndex(afterRemoval.value.circuit)
  console.log(
    `  removed C2 -> ${after.components.size} components, version ${afterRemoval.value.version}`,
  )
  const tracesBefore = buildIndex(beforeRemoval.circuit).traces.size
  console.log(
    `  its traces were pruned with it: ${after.traces.size} traces (was ${tracesBefore}) — a trace that no longer joins two things is removed, not left dangling`,
  )
  const restored = buildIndex(beforeRemoval.circuit)
  console.log(
    `  \x1b[32mundo\x1b[0m = the previous value, untouched: ${restored.components.size} components, version ${beforeRemoval.version}`,
  )
}

// ---------------------------------------------------------------- 9. federated search
rule("9. A missing API key degrades, it never breaks the search")

const registry = createDefaultRegistry()
registry.register({
  id: "digikey",
  label: "DigiKey",
  priority: 10,
  status: () => "disabled",
  disabledReason: () => "DIGIKEY_CLIENT_ID is not set",
  search: async () => {
    throw new Error("must never be called while disabled")
  },
  fetch: async () => undefined,
})

const federated = await federatedSearch(registry, "NE555")
console.log(`  results: ${federated.results.length} (top: ${federated.results[0]?.mpn})`)
for (const s of federated.sources) {
  console.log(
    `  source ${s.id.padEnd(9)} ${s.status.padEnd(9)} ${s.detail ?? `${s.count} result(s)`}`,
  )
}

console.log(`\n\x1b[32m${"─".repeat(72)}\x1b[0m`)
console.log("\x1b[32mDone.\x1b[0m M3 adds layout, so these components get coordinates.")
console.log(`\x1b[32m${"─".repeat(72)}\x1b[0m\n`)
