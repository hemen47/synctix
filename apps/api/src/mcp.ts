/**
 * MCP, served from the api process.
 *
 * The tools are **the agent's tools** — same names, same Zod schemas, same engine
 * underneath. An MCP client and our own agent are two callers of one surface, which is
 * the whole architecture in miniature: adding an Operation to core adds it to the REST
 * API, to the in-app agent and to every external MCP client at once, with nothing to
 * keep in step by hand.
 *
 * Two transports, one server definition:
 *
 * - **Streamable HTTP** at `/mcp`, for a remote client, behind the same bearer token
 *   Caddy already guards.
 * - **stdio**, for Claude Desktop and Cursor, via `apps/api/src/stdio-mcp.ts`.
 *
 * The one thing an MCP server needs that our agent does not is a **design to act on**.
 * An MCP client arrives with no session, so the design id is a tool argument, and
 * `list_designs` exists to find one.
 */

import { z } from "zod"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { runErc, summarizeForLLM, type Operation } from "@syntrix/core"
import { operationSchema } from "@syntrix/core"
import { AGENT_OPERATIONS, type AgentOperationName } from "@syntrix/agent"
import { LocalPartsIndex, T0_PARTS, type PartsIndex } from "@syntrix/parts"
import type { DesignStore } from "./store"

export interface McpDeps {
  store: DesignStore
  parts?: PartsIndex
  version?: string
}

/**
 * Descriptions for the MCP surface.
 *
 * Deliberately not the agent's descriptions verbatim: an MCP client has no system prompt
 * from us, so each tool has to carry its own context. "Connect two pins" is enough for a
 * model that has already been told the house rules; it is not enough for one that has not.
 */
const OPERATION_HELP: Record<AgentOperationName, string> = {
  add_component:
    "Add a component to a design. Prefer `partRef` (a catalog id like 't0:ne555', found " +
    "with search_parts) over a bare `ftype` — a catalog part brings a real pinout and a " +
    "verified footprint, and lets you wire by pin name afterwards.",
  remove_component: "Remove a component, and any trace left joining nothing.",
  set_prop: "Change a property such as resistance or capacitance. SI strings work: '10k', '100n'.",
  rename: "Change a component's reference designator.",
  connect:
    "Connect two pins, or a pin to a net. Pins are addressed by number or by any name the " +
    "part declares ('VCC', 'OUT'). Power and ground should always go through a named net " +
    "rather than a pin-to-pin chain.",
  disconnect: "Remove a connection.",
  create_net:
    "Create a named net. Mark it isGround or isPower — ERC uses that to check the design " +
    "has a ground reference.",
  rename_net: "Rename a net.",
  add_net_label: "Label a net on the schematic so a rail need not be drawn as a long wire.",
  add_power_symbol: "Attach a power or ground symbol to a net.",
  place_hint:
    "Record placement intent ('keep C1 near U1's VCC pin'). Coordinates are computed by " +
    "the layout engine and cannot be set directly.",
  batch:
    "Apply several operations atomically — all or nothing, and one undo step for the user. " +
    "Use it when a change is only correct as a whole, such as adding a part and wiring it.",
}

/**
 * Build the server.
 *
 * Returns a fresh `McpServer` per call, because the Streamable HTTP transport binds one
 * server to one session and reusing an instance across sessions leaks state between
 * clients.
 */
export const createMcpServer = (deps: McpDeps): McpServer => {
  const server = new McpServer({
    name: "syntrix",
    version: deps.version ?? "0.1.0",
  })

  const parts = deps.parts ?? new LocalPartsIndex(T0_PARTS)
  const designId = z.string().describe("A design id, from list_designs or create_design")

  // ---------------------------------------------------------------- designs

  server.tool(
    "list_designs",
    "List the designs on this server. Call this first — every other tool needs a design id.",
    {},
    async () => {
      const designs = await deps.store.list()
      return text(
        designs.length === 0
          ? "No designs yet. Use create_design to start one."
          : designs
              .map((d) => `${d.id}  "${d.name}"  v${d.version}  updated ${d.updatedAt}`)
              .join("\n"),
      )
    },
  )

  server.tool(
    "create_design",
    "Create an empty design and return its id.",
    { name: z.string().default("Untitled").describe("A human name for the design") },
    async ({ name }) => {
      const record = await deps.store.create(name)
      return text(`Created "${record.name}" with id ${record.id}.`)
    },
  )

  server.tool(
    "inspect_design",
    "Read a design: components, values, nets and connectivity. You never receive " +
      "coordinates — placement is computed, not something to reason about.",
    { designId },
    async ({ designId: id }) => {
      const found = await deps.store.get(id)
      if (!found) return error(`No design with id "${id}". Use list_designs.`)
      return text(summarizeForLLM(found.design, {}))
    },
  )

  server.tool(
    "run_erc",
    "Run electrical rule checks: dangling pins, single-pin nets, outputs shorted together, " +
      "power inputs with no driver, missing ground. Run this before you tell anyone the " +
      "design is finished.",
    { designId },
    async ({ designId: id }) => {
      const found = await deps.store.get(id)
      if (!found) return error(`No design with id "${id}".`)

      const report = runErc(found.design)
      if (report.violations.length === 0) return text("ERC passed with no violations.")

      return text(
        report.violations
          .map((v) => `[${v.severity}] ${v.rule}: ${v.message}${v.hint ? `\n  → ${v.hint}` : ""}`)
          .join("\n"),
      )
    },
  )

  server.tool(
    "design_history",
    "The operation log for a design — what changed, when, and who asked for it.",
    { designId },
    async ({ designId: id }) => {
      const entries = await deps.store.history(id)
      return text(
        entries.length === 0
          ? "No operations yet."
          : entries
              .map((e) => `${e.seq}. ${e.operation.type}  (${e.actor.kind})  ${e.at}`)
              .join("\n"),
      )
    },
  )

  // ---------------------------------------------------------------- operations

  for (const name of AGENT_OPERATIONS) {
    server.tool(
      name,
      OPERATION_HELP[name],
      {
        designId,
        // The operation's own fields, unparsed here and validated by core on submit. A
        // second schema in this file would be a second thing to keep in step, and it is
        // the engine's answer that matters anyway.
        args: z.record(z.unknown()).describe(`Fields for the ${name} operation, excluding "type".`),
      },
      async ({ designId: id, args }) => {
        const parsed = operationSchema.safeParse({ type: name, ...args })
        if (!parsed.success) {
          return error(
            `Invalid ${name}: ${parsed.error.issues
              .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
              .join("; ")}`,
          )
        }

        const result = await deps.store.submit(id, parsed.data as Operation, {
          actor: { kind: "agent" },
        })

        if (!result.ok) {
          // The engine's hint is what makes a rejection recoverable, so it goes back
          // verbatim rather than being flattened into "failed".
          return error(
            result.error.map((e) => `${e.code}: ${e.message}\nHint: ${e.hint}`).join("\n\n"),
          )
        }

        return text(
          `${name} applied. Design is at version ${result.value.record.version} with ` +
            `${result.value.design.circuit.length} elements.`,
        )
      },
    )
  }

  // ---------------------------------------------------------------- parts

  server.tool(
    "search_parts",
    "Search the parts catalog. Results marked unverified have a footprint nobody has " +
      "checked — say so if you use one.",
    {
      query: z.string().describe("What an engineer would type: '3.3V LDO SOT-223', 'NE555'"),
      limit: z.number().int().min(1).max(25).default(10),
    },
    async ({ query, limit }) => {
      const results = await parts.search(query, { limit })
      return text(
        results.length === 0
          ? `Nothing matched "${query}".`
          : results
              .map(
                (r) =>
                  `${r.id}  ${r.mpn ?? ""}  ${r.package ?? r.category}` +
                  `${r.footprintVerified ? "" : "  [footprint unverified]"}\n    ${r.description}`,
              )
              .join("\n"),
      )
    },
  )

  server.tool(
    "get_pinout",
    "A part's pins with their names and functions. Look this up before wiring an IC — " +
      "guessing which pin is VCC is how boards are destroyed.",
    { partId: z.string().describe("A part id from search_parts, e.g. 't0:ne555'") },
    async ({ partId }) => {
      const part = await parts.get(partId)
      if (!part) return error(`No part with id "${partId}". Use search_parts.`)

      return text(
        [
          `${part.id}${part.mpn ? ` (${part.mpn})` : ""} — ${part.description}`,
          `footprint: ${part.footprint.verification}`,
          "",
          ...part.pins.map(
            (pin) =>
              `  ${pin.number}. ${pin.name} [${pin.kind}]` +
              (pin.altNames.length > 0 ? `  aka ${pin.altNames.join(", ")}` : ""),
          ),
        ].join("\n"),
      )
    },
  )

  return server
}

const text = (body: string) => ({ content: [{ type: "text" as const, text: body }] })

const error = (body: string) => ({
  content: [{ type: "text" as const, text: body }],
  isError: true,
})
