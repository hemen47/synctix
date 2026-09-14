import { describe, expect, it } from "vitest"
import { operationSchema } from "./operations"

/**
 * The Operation union is the API every surface writes against, so its parsing behaviour
 * is pinned here rather than discovered at runtime. `batch` in particular is built with
 * `z.lazy` to allow recursion, which is worth a test of its own.
 */

describe("operationSchema", () => {
  it("parses add_component and leaves SI strings for circuit-json to normalise", () => {
    const result = operationSchema.safeParse({
      type: "add_component",
      ftype: "simple_resistor",
      name: "R1",
      props: { resistance: "10k" },
    })

    expect(result.success).toBe(true)
    // circuit-json parses "10k" into 10000 at element construction (ADR-0003); the
    // operation layer must not convert it first, or the value would be double-parsed.
    if (result.success) expect(result.data).toMatchObject({ props: { resistance: "10k" } })
  })

  it("defaults props to an empty object", () => {
    const result = operationSchema.safeParse({ type: "add_component", ftype: "simple_capacitor" })
    expect(result.success).toBe(true)
    if (result.success && result.data.type === "add_component") {
      expect(result.data.props).toEqual({})
    }
  })

  it("accepts a connect to a net and a connect to another port", () => {
    expect(
      operationSchema.safeParse({
        type: "connect",
        a: { component: "R1", pin: 1 },
        b: { net: "VIN" },
      }).success,
    ).toBe(true)

    expect(
      operationSchema.safeParse({
        type: "connect",
        a: { component: "R1", pin: 2 },
        b: { component: "C1", pin: 1 },
      }).success,
    ).toBe(true)
  })

  it("accepts pin references by number or by name", () => {
    for (const pin of [1, "1", "VCC", "OUT"]) {
      expect(
        operationSchema.safeParse({
          type: "connect",
          a: { component: "U1", pin },
          b: { net: "VCC" },
        }).success,
      ).toBe(true)
    }
  })

  it("parses place_hint with a decoupling constraint", () => {
    const result = operationSchema.safeParse({
      type: "place_hint",
      component: "C1",
      constraints: [{ kind: "decoupling_for", component: "U1", pin: "VCC" }],
    })
    expect(result.success).toBe(true)
  })

  it("rejects place_hint with no constraints", () => {
    // An empty hint is a silent no-op, which would let the agent believe it had placed
    // something.
    const result = operationSchema.safeParse({
      type: "place_hint",
      component: "C1",
      constraints: [],
    })
    expect(result.success).toBe(false)
  })

  it("parses nested batches and applies defaults throughout", () => {
    const result = operationSchema.safeParse({
      type: "batch",
      ops: [
        { type: "rename", component: "R1", name: "R2" },
        { type: "batch", ops: [{ type: "create_net", name: "GND" }] },
      ],
    })

    expect(result.success).toBe(true)
    if (result.success && result.data.type === "batch") {
      expect(result.data.atomic).toBe(true)
      const inner = result.data.ops[1]
      expect(inner?.type).toBe("batch")
      if (inner?.type === "batch") {
        const net = inner.ops[0]
        // Defaults must survive the recursion, not just the top level.
        expect(net).toMatchObject({ type: "create_net", name: "GND", isGround: false })
      }
    }
  })

  it("rejects an empty batch", () => {
    expect(operationSchema.safeParse({ type: "batch", ops: [] }).success).toBe(false)
  })

  it("rejects an unknown operation type with a discriminator error", () => {
    const result = operationSchema.safeParse({ type: "explode_board" })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain("discriminator")
    }
  })

  it("rejects a known operation with a missing required field", () => {
    const result = operationSchema.safeParse({ type: "rename", component: "R1" })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(["name"])
  })

  it("defaults merge_circuit_json to a name-based merge", () => {
    const result = operationSchema.safeParse({ type: "merge_circuit_json", elements: [] })
    expect(result.success).toBe(true)
    if (result.success && result.data.type === "merge_circuit_json") {
      // Replacing the whole document by default would make TSX mode destructive.
      expect(result.data.strategy).toBe("merge_by_name")
    }
  })

  it("defaults move_component to pinned, so a user drag survives relayout", () => {
    const result = operationSchema.safeParse({
      type: "move_component",
      component: "R1",
      center: { x: 10, y: 20 },
    })
    expect(result.success).toBe(true)
    if (result.success && result.data.type === "move_component") {
      expect(result.data.pinned).toBe(true)
    }
  })
})
