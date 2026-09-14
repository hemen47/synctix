/**
 * Eject to TSX, and the proof that it is a real round trip: the generated source is fed
 * back through `compileTsx`, and the circuit that comes out has to have the same
 * components and the same connectivity.
 *
 * That is the only assertion worth making here. Comparing the generated string to a
 * golden file would pin the formatting and test nothing about whether the output is
 * valid tscircuit.
 */

import { beforeEach, describe, expect, it } from "vitest"
import { createSequentialIdFactory, setIdFactory } from "@syntrix/shared"
import { applyAll, createDesign } from "./apply"
import { ejectToTsx } from "./eject-tsx"
import { buildIndex, electricalNets } from "./index-view"
import { compileTsx } from "./tsx"
import { rcLowpassOperations } from "./__fixtures__/rc-lowpass"
import type { Operation } from "./operations"

const EVAL_TIMEOUT = 60_000

const build = (...ops: Operation[]) => {
  const result = applyAll(createDesign("d"), ops)
  if (!result.ok) throw new Error(result.error.map((e) => e.message).join(" | "))
  return result.value
}

describe("ejectToTsx", () => {
  beforeEach(() => setIdFactory(createSequentialIdFactory()))

  it("emits a board with one element per component", () => {
    const { code } = ejectToTsx(build(...rcLowpassOperations))

    expect(code).toContain("<board")
    expect(code).toContain('<resistor name="R1"')
    expect(code).toContain('<capacitor name="C1"')
  })

  it("keeps the value the author wrote rather than the parsed number", () => {
    const { code } = ejectToTsx(
      build({
        type: "add_component",
        ftype: "simple_resistor",
        name: "R1",
        props: { resistance: "10k" },
      }),
    )

    // "10k" is what a person typed and what tscircuit parses; 10000 is a lossy rendering
    // of the same thing.
    expect(code).toContain('resistance="10k"')
  })

  it("carries manual placement across as schX/schY", () => {
    const { code } = ejectToTsx(
      build(
        { type: "add_component", ftype: "simple_resistor", name: "R1", props: {} },
        { type: "move_component", component: "R1", center: { x: 5, y: -2.5 }, layer: "schematic" },
      ),
    )

    expect(code).toContain("schX={5}")
    expect(code).toContain("schY={-2.5}")
  })

  it("says in the file itself what it could not carry", () => {
    const design = build({
      type: "add_component",
      ftype: "simple_resistor",
      name: "R1",
      props: {},
    })
    const { code, limitations } = ejectToTsx(design)

    // A reader must find out about a lossy export from the file, not from a surprise.
    expect(limitations.length).toBeGreaterThan(0)
    expect(code).toContain("Not carried across:")
    expect(code).toContain("one-way")
  })

  it(
    "produces source that compiles back to the same circuit",
    async () => {
      const original = build(...rcLowpassOperations)
      const { code } = ejectToTsx(original)

      const recompiled = await compileTsx(`circuit.add(${wrapBody(code)})`)
      expect(recompiled.ok).toBe(true)
      if (!recompiled.ok) return

      const before = buildIndex(original.circuit)
      const after = buildIndex(recompiled.value.elements)

      expect([...after.componentsByName.keys()].sort()).toEqual(
        [...before.componentsByName.keys()].sort(),
      )

      // Connectivity, not just component count: an export that dropped the traces would
      // otherwise pass.
      expect(connectionPairs(after)).toEqual(connectionPairs(before))
    },
    EVAL_TIMEOUT,
  )
})

/** The generated file is a module; the compiler wants the JSX on its own. */
const wrapBody = (code: string): string => {
  const start = code.indexOf("<board")
  const end = code.lastIndexOf("</board>") + "</board>".length
  return code.slice(start, end)
}

/**
 * Connectivity as a comparable value: the set of component-pin pairs sharing a net.
 * Ids differ between the two documents, so names are the only stable handle.
 */
const connectionPairs = (view: ReturnType<typeof buildIndex>): string[] => {
  const pairs: string[] = []
  for (const net of electricalNets(view)) {
    const members: string[] = []
    for (const portId of net.ports) {
      const port = view.byId.get(portId)
      if (!port || port.type !== "source_port" || !port.source_component_id) continue
      const component = view.components.get(port.source_component_id)
      if (!component) continue
      members.push(`${component.name}.${port.pin_number}`)
    }
    if (members.length > 1) pairs.push(members.sort().join("—"))
  }
  return pairs.sort()
}
