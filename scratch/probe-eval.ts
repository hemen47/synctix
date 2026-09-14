import { runTscircuitCode } from "@tscircuit/eval"

const code = `
import { sel } from "tscircuit"

export default () => (
  <board width="20mm" height="20mm">
    <resistor name="R1" resistance="10k" footprint="0603" schX={-2} />
    <capacitor name="C1" capacitance="100nF" footprint="0603" schX={2} />
    <trace from=".R1 > .pin2" to=".C1 > .pin1" />
  </board>
)
`

const circuitJson = await runTscircuitCode(code)
const byType = new Map<string, unknown[]>()
for (const el of circuitJson as Array<{ type: string }>) {
  if (!byType.has(el.type)) byType.set(el.type, [])
  byType.get(el.type)!.push(el)
}
console.log("=== element type counts ===")
for (const [t, els] of [...byType].sort()) console.log(`${els.length.toString().padStart(3)}  ${t}`)

console.log("\n=== source_component ===")
console.log(JSON.stringify(byType.get("source_component"), null, 1))
console.log("\n=== source_port ===")
console.log(JSON.stringify(byType.get("source_port"), null, 1))
console.log("\n=== source_trace ===")
console.log(JSON.stringify(byType.get("source_trace"), null, 1))
console.log("\n=== source_net ===")
console.log(JSON.stringify(byType.get("source_net"), null, 1))
