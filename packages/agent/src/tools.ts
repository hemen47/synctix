/**
 * The agent's tools.
 *
 * Every mutating tool is an Operation and nothing else (principle 2). The agent has no
 * private path into a design: it submits what the REST API submits, gets back what the
 * REST API gets back, and fails the same way. That is what makes "the agent broke my
 * schematic" a question the operation log can answer.
 *
 * Two tools are deliberately absent:
 *
 * - **`move_component`.** The model never places anything (principle 4). It gets
 *   `place_hint`, which records intent — "keep C1 near U1's VCC pin" — and lets layout
 *   compute coordinates. A model that could set positions would spend its context on
 *   arithmetic and produce a worse drawing than ELK.
 * - **`undo`.** Undo is the user's, not the agent's. An agent that can undo can hide a
 *   mistake instead of reporting it.
 */

import { z } from "zod"
import { zodToJsonSchema } from "zod-to-json-schema"
import { operationSchema } from "@syntrix/core"
import type { ToolDefinition } from "./types"

/**
 * Operations the agent may submit, by name.
 *
 * A list rather than "everything in the union", because the union is the *engine's*
 * surface and this is the *model's*. `merge_circuit_json` is here because TSX mode lands
 * through it, but the model reaches it via `generate_tsx_circuit` rather than by
 * assembling elements by hand.
 */
export const AGENT_OPERATIONS = [
  "add_component",
  "remove_component",
  "set_prop",
  "rename",
  "connect",
  "disconnect",
  "create_net",
  "rename_net",
  "add_net_label",
  "add_power_symbol",
  "place_hint",
  "batch",
] as const

export type AgentOperationName = (typeof AGENT_OPERATIONS)[number]

/**
 * The JSON Schema for one operation, taken from core's own Zod definition.
 *
 * Derived rather than written out, so the tool surface and the engine cannot drift: an
 * Operation that gains a field gains it here on the next build. `zod-to-json-schema`
 * rather than Zod 4's native converter, because zod is pinned to v3 (ADR-0002).
 */
export const operationJsonSchema = (name: AgentOperationName): Record<string, unknown> => {
  const branch = branchFor(name)
  if (!branch) throw new Error(`No operation schema named "${name}".`)

  const schema = zodToJsonSchema(branch, {
    $refStrategy: "none",
    // A provider rejects a schema with a top-level $ref, and most reject $defs too.
    target: "jsonSchema7",
  }) as Record<string, unknown>

  // `type` is fixed by the tool name; leaving it in invites the model to set it wrongly
  // and wastes a field of every call.
  const properties = schema["properties"] as Record<string, unknown> | undefined
  if (properties) delete properties["type"]
  const required = schema["required"] as string[] | undefined
  if (required) schema["required"] = required.filter((field) => field !== "type")

  return schema
}

/** Find one branch of core's discriminated union by its literal `type`. */
const branchFor = (name: string): z.ZodTypeAny | undefined => {
  // `operationSchema` is a ZodLazy wrapping the union; unwrap it once.
  const lazy = operationSchema as unknown as { _def?: { getter?: () => unknown } }
  const union = (lazy._def?.getter?.() ?? operationSchema) as unknown as {
    _def?: { options?: z.ZodTypeAny[] }
  }

  for (const option of union._def?.options ?? []) {
    const shape = (option as unknown as { shape?: { type?: { _def?: { value?: unknown } } } }).shape
    if (shape?.type?._def?.value === name) return option
  }
  return undefined
}

export interface ToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown>
  mutates: boolean
  requiresApproval?: boolean
}

/**
 * Descriptions the model actually reads.
 *
 * Written for a model rather than for a docs page: each says what the tool does, when to
 * reach for it, and — where there is one — the mistake it most often prevents. A
 * description that only restates the name is a wasted opportunity to stop a bad call.
 */
const OPERATION_DESCRIPTIONS: Record<AgentOperationName, string> = {
  add_component:
    "Add a component. Prefer `partRef` (a catalog part id such as 't0:ams1117') over a bare " +
    "`ftype`: a catalog part brings a real pinout, a footprint and a SPICE model, so you can " +
    "then connect by pin name ('VCC', 'OUT') rather than by number.",
  remove_component:
    "Remove a component and everything connected only to it. Traces that no longer join " +
    "anything are removed with it.",
  set_prop:
    "Change one property, e.g. resistance or capacitance. Values may be SI strings ('10k', " +
    "'100n'); they are parsed for you.",
  rename: "Change a component's reference designator.",
  connect:
    "Connect two pins, or a pin to a net. Address a pin by number or by any name the part " +
    "declares ('VCC', 'OUT', 'pin3'). Connecting to a named net is usually clearer than " +
    "chaining pin-to-pin, and is how power and ground should always be wired.",
  disconnect: "Remove a connection between two pins, or a pin from a net.",
  create_net:
    "Create a named net. Mark it `isGround` or `isPower` — ERC uses that to check the design " +
    "has a ground reference and that no output drives a supply.",
  rename_net: "Rename a net.",
  add_net_label: "Label a net on the schematic, so a rail need not be drawn as a long wire.",
  add_power_symbol: "Attach a power or ground symbol to a net.",
  place_hint:
    "Record placement intent — 'keep C1 within 5mm of U1', 'put the connector on the west " +
    "edge'. This is how you influence the drawing: you cannot set coordinates, and should " +
    "not try. Decoupling capacitors should always carry a `decoupling_for` hint.",
  batch:
    "Apply several operations as one step. Atomic by default: if any fails, none are applied, " +
    "and the whole batch is one undo for the user. Use it for a change that is only correct " +
    "as a whole — adding a part and wiring it, say.",
}

/** Every operation tool, ready to hand to a provider. */
export const operationTools = (): ToolSpec[] =>
  AGENT_OPERATIONS.map((name) => ({
    name,
    description: OPERATION_DESCRIPTIONS[name],
    parameters: operationJsonSchema(name),
    mutates: true,
  }))

// ---------------------------------------------------------------- read-only tools

export const inspectDesignInput = z.object({
  /** Cap the summary so one tool result cannot swallow the context window. */
  budgetTokens: z.number().int().positive().max(20_000).optional(),
})

export const runErcInput = z.object({})

export const searchPartsInput = z.object({
  query: z.string().min(1).describe("What an engineer would type: '3.3V LDO SOT-223', 'NE555'"),
  category: z.string().optional(),
  package: z.string().optional(),
  limit: z.number().int().min(1).max(25).default(10),
})

export const getPinoutInput = z.object({
  partId: z.string().describe("A part id from search_parts, e.g. 't0:ne555'"),
})

export const simulateInput = z.object({
  analysis: z
    .enum(["op", "ac", "tran"])
    .describe("op for bias points, ac for frequency response, tran for time domain"),
  startHz: z.number().positive().optional(),
  stopHz: z.number().positive().optional(),
  stop: z.string().optional().describe("Transient stop time, e.g. '10m'"),
  step: z.string().optional().describe("Transient step, e.g. '1u'"),
})

export const generateTsxInput = z.object({
  code: z
    .string()
    .min(1)
    .describe(
      "A tscircuit snippet that calls circuit.add(<board>…</board>). Written against the " +
        "tscircuit skill in your system prompt. Imports are not resolved — use built-in " +
        "elements only.",
    ),
  strategy: z
    .enum(["merge_by_name", "append_only", "replace_all"])
    .default("merge_by_name")
    .describe(
      "merge_by_name updates same-named components and is almost always right. " +
        "replace_all discards the existing design.",
    ),
})

export const exportInput = z.object({
  format: z.enum(["spice", "kicad", "svg", "bom-csv", "pnp-csv", "ltspice-asc"]),
})

/**
 * The read-only and bridge tools.
 *
 * `generate_tsx_circuit` is the one that needs care in its description: a model told only
 * "write tscircuit" will try to import packages and call CLI commands, because that is
 * what the skill document describes. It has to be told what this environment is.
 */
export const supportTools = (): ToolSpec[] => [
  {
    name: "inspect_design",
    description:
      "Read the current design: components, values, nets and what is connected to what. " +
      "Call this first, and again after any change you did not make yourself. You never " +
      "see coordinates — placement is not yours to reason about.",
    parameters: jsonSchema(inspectDesignInput),
    mutates: false,
  },
  {
    name: "run_erc",
    description:
      "Run electrical rule checks: dangling pins, single-pin nets, outputs shorted together, " +
      "power inputs with no driver, missing ground. **You must call this before finishing.** " +
      "A design that has not been checked is not a design.",
    parameters: jsonSchema(runErcInput),
    mutates: false,
  },
  {
    name: "search_parts",
    description:
      "Search the parts catalog. Prefer a part from here over a bare ftype: it brings a " +
      "verified footprint and a real pinout. Results marked unverified have a footprint " +
      "nobody has checked — say so if you use one.",
    parameters: jsonSchema(searchPartsInput),
    mutates: false,
  },
  {
    name: "get_pinout",
    description:
      "A part's pins, with their names and functions. Call this before wiring an IC — " +
      "guessing which pin is VCC is the single most common way to destroy a board.",
    parameters: jsonSchema(getPinoutInput),
    mutates: false,
  },
  {
    name: "simulate",
    description:
      "Simulate and get measurements back — node voltages, the −3 dB corner, rise time, " +
      "overshoot. You receive metrics, never raw waveforms. Call this whenever the request " +
      "was about behaviour ('a 1kHz filter') rather than structure.",
    parameters: jsonSchema(simulateInput),
    mutates: false,
  },
  {
    name: "generate_tsx_circuit",
    description:
      "Write the circuit as tscircuit TSX; it is compiled and merged into the design. This " +
      "is the best way to create a whole circuit at once — use operations for edits and " +
      "fixes afterwards. Note: there is no shell and no `tsci` CLI here, and imports are " +
      "not resolved, so use only built-in elements (<board>, <resistor>, <chip>, <trace>…). " +
      "Compile errors and unresolved trace selectors come back to you to fix.",
    parameters: jsonSchema(generateTsxInput),
    mutates: true,
  },
  {
    name: "export",
    description: "Export the design in a fabrication or simulation format.",
    parameters: jsonSchema(exportInput),
    mutates: false,
  },
]

const jsonSchema = (schema: z.ZodTypeAny): Record<string, unknown> =>
  zodToJsonSchema(schema, { $refStrategy: "none", target: "jsonSchema7" }) as Record<
    string,
    unknown
  >

/** Everything the model is offered. */
export const allTools = (): ToolSpec[] => [...operationTools(), ...supportTools()]

/** A tool by name, for dispatch. */
export const toolByName = (name: string): ToolSpec | undefined =>
  allTools().find((tool) => tool.name === name)

export type { ToolDefinition }
