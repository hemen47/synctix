/**
 * Operations — the only way a design ever changes.
 *
 * Every surface (web UI, REST API, LLM agent, MCP server) submits one of these and core
 * applies it. A client that needs something not expressible here adds an Operation; it
 * does not reach past this file.
 */

import { z } from "zod"

export const portRefSchema = z.object({
  component: z.string().min(1).describe('Component refdes, e.g. "U1", or its source_component_id'),
  pin: z
    .union([z.string(), z.number()])
    .describe('Pin number, pin name, or a known alternate name such as "VCC"'),
})

export const netRefSchema = z.object({
  net: z.string().min(1).describe('Net name, e.g. "GND" or "VOUT"'),
})

export const connectionEndpointSchema = z.union([portRefSchema, netRefSchema])

export const placementConstraintSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("near"),
    target: z.string(),
    maxDistanceMm: z.number().positive().optional(),
  }),
  z.object({
    kind: z.literal("side"),
    of: z.string(),
    side: z.enum(["north", "south", "east", "west"]),
  }),
  z.object({ kind: z.literal("align"), with: z.string(), axis: z.enum(["x", "y"]) }),
  z.object({ kind: z.literal("group"), groupId: z.string() }),
  z.object({ kind: z.literal("decoupling_for"), component: z.string(), pin: z.string() }),
])

/**
 * Props are free-form because each ftype has its own (resistance, capacitance,
 * inductance, voltage...). circuit-json's own schema validates them on construction and
 * parses SI strings such as "10k" into numbers (ADR-0003), so we accept strings and
 * numbers here and let the element factory reject what is genuinely wrong.
 */
export const propValueSchema = z.union([z.string(), z.number(), z.boolean()])

const baseOps = [
  z.object({
    type: z.literal("add_component"),
    /** A part definition id from @syntrix/parts. Preferred over a bare ftype. */
    partRef: z.string().optional(),
    /** Fallback when no catalog part applies — a circuit-json ftype. */
    ftype: z.string().optional(),
    /** Refdes. Auto-assigned from the ftype prefix when omitted. */
    name: z.string().optional(),
    props: z.record(propValueSchema).default({}),
  }),

  z.object({
    type: z.literal("remove_component"),
    component: z.string(),
  }),

  z.object({
    type: z.literal("set_prop"),
    component: z.string(),
    key: z.string(),
    value: propValueSchema,
  }),

  z.object({
    type: z.literal("rename"),
    component: z.string(),
    name: z.string().min(1),
  }),

  z.object({
    type: z.literal("connect"),
    a: portRefSchema,
    b: connectionEndpointSchema,
  }),

  z.object({
    type: z.literal("disconnect"),
    a: portRefSchema,
    b: connectionEndpointSchema,
  }),

  z.object({
    type: z.literal("create_net"),
    name: z.string().min(1),
    isPower: z.boolean().default(false),
    isGround: z.boolean().default(false),
  }),

  z.object({
    type: z.literal("rename_net"),
    net: z.string(),
    name: z.string().min(1),
  }),

  z.object({
    type: z.literal("add_net_label"),
    net: z.string(),
    at: portRefSchema.optional(),
  }),

  z.object({
    type: z.literal("add_power_symbol"),
    net: z.string(),
    kind: z.enum(["vcc", "gnd", "vdd", "vss", "custom"]).default("custom"),
    voltage: z.union([z.string(), z.number()]).optional(),
  }),

  /**
   * The agent's only placement verb. It records intent; @syntrix/layout turns intent
   * into coordinates (principle 4).
   */
  z.object({
    type: z.literal("place_hint"),
    component: z.string(),
    constraints: z.array(placementConstraintSchema).min(1),
  }),

  /**
   * Absolute placement. Reserved for the user and the layout engine — the agent tool
   * surface does not expose it.
   *
   * Writes `design.manualEdits`, which layout reads and never overwrites. There is no
   * `pinned` flag: presence in `manualEdits` *is* pinned, which is also what tscircuit
   * means by it (ADR-0013).
   */
  z.object({
    type: z.literal("move_component"),
    component: z.string(),
    center: z.object({ x: z.number(), y: z.number() }),
    rotation: z.number().optional(),
    /** Which drawing the placement applies to. */
    layer: z.enum(["schematic", "pcb"]).default("schematic"),
  }),

  /** Hand a component back to automatic layout, discarding the manual placement. */
  z.object({
    type: z.literal("clear_placement"),
    component: z.string(),
    layer: z.enum(["schematic", "pcb"]).default("schematic"),
  }),

  /**
   * How TSX mode lands. `@tscircuit/eval` turns an LLM-authored <board> snippet into
   * circuit-json in a sandbox; the result enters through this one validated door.
   */
  z.object({
    type: z.literal("merge_circuit_json"),
    elements: z.array(z.unknown()),
    strategy: z.enum(["replace_all", "merge_by_name", "append_only"]).default("merge_by_name"),
  }),
] as const

export type OperationInput = z.input<(typeof baseOps)[number]>

/**
 * `batch` is defined separately because it is recursive: it contains operations,
 * including other batches. Zod needs the lazy indirection.
 */
export const operationSchema: z.ZodType<Operation> = z.lazy(() =>
  z.discriminatedUnion("type", [
    ...baseOps,
    z.object({
      type: z.literal("batch"),
      ops: z.array(operationSchema).min(1),
      /** Batches are all-or-nothing: any failing op rolls the whole batch back. */
      atomic: z.boolean().default(true),
    }),
  ] as never),
) as z.ZodType<Operation>

type BaseOperation = z.output<(typeof baseOps)[number]>

export type Operation = BaseOperation | { type: "batch"; ops: Operation[]; atomic: boolean }

export type OperationType = Operation["type"]

/** One entry in the append-only log. Snapshots derive from a replay of these. */
export interface LoggedOperation {
  id: string
  designId: string
  /** Design version this operation produced. */
  version: number
  operation: Operation
  at: string
  actor: { kind: "user" | "agent" | "api" | "mcp"; id?: string; runId?: string }
  /** Elements the operation created or touched, for audit and UI highlighting. */
  affectedIds: string[]
}
