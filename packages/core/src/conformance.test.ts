/**
 * Conformance: what core produces has to be readable by the tscircuit toolchain.
 *
 * Passing `circuit-json`'s Zod schemas is necessary but not sufficient — a document can
 * be schema-valid and still make a consumer throw, because the schema says almost every
 * field is optional and a renderer has opinions about which ones it needs. So the check
 * here is the one that matters in practice: render each fixture with `circuit-to-svg`,
 * the same library our own SVG export and the tscircuit viewers use, and require that it
 * produces an SVG rather than throwing.
 *
 * This is the load-bearing test for principle 1. If core ever starts emitting a document
 * tscircuit cannot read, this fails long before anyone tries to export a board.
 */

import { beforeEach, describe, expect, it } from "vitest"
import { convertCircuitJsonToPcbSvg, convertCircuitJsonToSchematicSvg } from "circuit-to-svg"
import { createSequentialIdFactory, setIdFactory } from "@syntrix/shared"
import { applyAll, createDesign } from "./apply"
import { validateCircuit } from "./elements"
import { rcLowpassOperations } from "./__fixtures__/rc-lowpass"
import type { Design } from "./types"
import type { Operation } from "./operations"

const build = (ops: Operation[]): Design => {
  const result = applyAll(createDesign("d"), ops)
  if (!result.ok) throw new Error(result.error.map((e) => e.message).join(" | "))
  return result.value
}

/**
 * A divider feeding an LED, plus a ground reference.
 *
 * Deliberately built from ftypes core knows on its own: core carries only enough pin
 * knowledge to build a valid element from a bare ftype, and real pinouts live in
 * `@syntrix/parts` behind a resolver. A conformance test that needed the parts layer
 * would be testing the wrong package.
 */
const dividerLed: Operation[] = [
  { type: "add_component", ftype: "simple_resistor", name: "R1", props: { resistance: "10k" } },
  { type: "add_component", ftype: "simple_resistor", name: "R2", props: { resistance: "4.7k" } },
  { type: "add_component", ftype: "simple_led", name: "D1", props: {} },
  { type: "add_component", ftype: "simple_ground", name: "GND1", props: {} },
  // A three-member net: the divider tap drives the LED anode.
  { type: "connect", a: { component: "R1", pin: 2 }, b: { component: "R2", pin: 1 } },
  { type: "connect", a: { component: "R2", pin: 1 }, b: { component: "D1", pin: "anode" } },
  { type: "connect", a: { component: "D1", pin: "cathode" }, b: { component: "GND1", pin: 1 } },
  { type: "connect", a: { component: "R2", pin: 2 }, b: { component: "GND1", pin: 1 } },
]

const fixtures: Array<{ name: string; ops: Operation[] }> = [
  { name: "rc_lowpass", ops: rcLowpassOperations },
  { name: "divider_led", ops: dividerLed },
]

describe("circuit-json conformance", () => {
  beforeEach(() => setIdFactory(createSequentialIdFactory()))

  for (const fixture of fixtures) {
    it(`${fixture.name}: every element parses through any_circuit_element`, () => {
      const design = build(fixture.ops)
      const result = validateCircuit(design.circuit)

      expect(result.ok).toBe(true)
      if (!result.ok) {
        throw new Error(result.error.map((e) => e.message).join("\n"))
      }
    })

    it(`${fixture.name}: renders through circuit-to-svg without throwing`, () => {
      const design = build(fixture.ops)

      // Core emits the source layer only; layout owns schematic_* elements. A renderer
      // handed a source-only document must still cope, because that is exactly the state
      // a design is in between an agent's edit and the next relayout.
      const svg = convertCircuitJsonToSchematicSvg(design.circuit as never)

      expect(typeof svg).toBe("string")
      expect(svg).toContain("<svg")
    })

    it(`${fixture.name}: survives the PCB renderer too`, () => {
      const design = build(fixture.ops)

      // There is no pcb layer yet either. The assertion is not that a board appears —
      // it is that a consumer reading our document does not hit an exception.
      const svg = convertCircuitJsonToPcbSvg(design.circuit as never)

      expect(typeof svg).toBe("string")
      expect(svg).toContain("<svg")
    })
  }

  it("keeps the sidecar out of the document", () => {
    // Principle 2, mechanically: operations that write meta must leave `circuit` alone.
    const design = build([
      ...rcLowpassOperations,
      { type: "move_component", component: "R1", center: { x: 5, y: 5 }, layer: "schematic" },
      {
        type: "place_hint",
        component: "C1",
        constraints: [{ kind: "near", target: "R1" }],
      },
    ])

    expect(validateCircuit(design.circuit).ok).toBe(true)
    // The placement is in manualEdits, and nowhere in the elements themselves.
    expect(JSON.stringify(design.circuit)).not.toContain("group_center")
    expect(design.manualEdits.schematic_placements).toHaveLength(1)
  })
})
