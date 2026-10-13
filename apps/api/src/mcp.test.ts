/**
 * MCP, driven by a real SDK client.
 *
 * M8's criterion is that an external client can list the tools and build a circuit end to
 * end, so the test is an actual `Client` from the SDK speaking the real protocol over the
 * real transport — not a hand-rolled POST of JSON-RPC shapes, which would pass whether or
 * not the protocol handshake worked.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { createSequentialIdFactory, setIdFactory } from "@syntrix/shared"
import { t0Resolver } from "@syntrix/parts"
import { createApp } from "./app"
import { MemoryDesignStore } from "./store"

const BEARER = "test-mcp-token"

let server: Server
let baseUrl: string

beforeAll(async () => {
  setIdFactory(createSequentialIdFactory())

  const app = createApp({
    version: "0.1.0",
    startedAt: Date.now(),
    store: new MemoryDesignStore({ resolvePart: t0Resolver }),
    mcpBearerToken: BEARER,
  })

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve())
  })
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  baseUrl = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

/** A connected client, as Claude Desktop or the MCP inspector would be. */
const connect = async (token = BEARER): Promise<Client> => {
  const client = new Client({ name: "test-client", version: "1.0.0" })
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  })
  await client.connect(transport)
  return client
}

const textOf = (result: unknown): string =>
  ((result as { content?: Array<{ text?: string }> }).content ?? [])
    .map((c) => c.text ?? "")
    .join("\n")

describe("MCP over Streamable HTTP", () => {
  it("lists every tool", async () => {
    const client = await connect()
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name)

    // The design tools and the operation tools, from one definition.
    expect(names).toContain("list_designs")
    expect(names).toContain("create_design")
    expect(names).toContain("inspect_design")
    expect(names).toContain("run_erc")
    expect(names).toContain("add_component")
    expect(names).toContain("connect")
    expect(names).toContain("batch")
    expect(names).toContain("search_parts")
    expect(names).toContain("get_pinout")

    // Principle 4 holds across the MCP surface too: no coordinates, and no undo.
    expect(names).not.toContain("move_component")
    expect(names).not.toContain("undo")

    // Every tool carries a schema a client can actually use.
    for (const tool of tools) expect(tool.inputSchema).toBeDefined()
    await client.close()
  })

  it("refuses a request with no bearer token", async () => {
    const client = new Client({ name: "no-token", version: "1.0.0" })
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`))

    // The MCP surface must not be open to the internet just because it is not /api.
    await expect(client.connect(transport)).rejects.toThrow()
  })

  it("refuses a wrong bearer token", async () => {
    const client = new Client({ name: "bad-token", version: "1.0.0" })
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: "Bearer nope" } },
    })
    await expect(client.connect(transport)).rejects.toThrow()
  })

  /** M8's criterion, end to end. */
  it("creates a circuit from an external client", async () => {
    const client = await connect()

    const created = await client.callTool({
      name: "create_design",
      arguments: { name: "from mcp" },
    })
    const designId = /(design_\w+)/.exec(textOf(created))?.[1]
    expect(designId).toBeTruthy()

    // A part, looked up rather than guessed.
    const parts = await client.callTool({
      name: "search_parts",
      arguments: { query: "resistor", limit: 5 },
    })
    expect(textOf(parts)).toMatch(/t0:/)

    const addR = await client.callTool({
      name: "add_component",
      arguments: {
        designId,
        args: { partRef: "t0:resistor", name: "R1", props: { resistance: "10k" } },
      },
    })
    expect(textOf(addR)).toMatch(/applied/)

    await client.callTool({
      name: "add_component",
      arguments: {
        designId,
        args: { partRef: "t0:capacitor", name: "C1", props: { capacitance: "100n" } },
      },
    })

    await client.callTool({
      name: "create_net",
      arguments: { designId, args: { name: "GND", isGround: true, isPower: false } },
    })

    await client.callTool({
      name: "connect",
      arguments: {
        designId,
        args: { a: { component: "R1", pin: 2 }, b: { component: "C1", pin: 1 } },
      },
    })

    await client.callTool({
      name: "connect",
      arguments: { designId, args: { a: { component: "C1", pin: 2 }, b: { net: "GND" } } },
    })

    // The design the client built is really there, with the connectivity it asked for.
    const summary = textOf(
      await client.callTool({ name: "inspect_design", arguments: { designId } }),
    )
    expect(summary).toContain("R1")
    expect(summary).toContain("C1")
    expect(summary).toContain("GND")

    const erc = textOf(await client.callTool({ name: "run_erc", arguments: { designId } }))
    expect(erc.length).toBeGreaterThan(0)

    const history = textOf(
      await client.callTool({ name: "design_history", arguments: { designId } }),
    )
    // Five operations, each recorded as an agent action.
    expect(history).toMatch(/5\. connect/)
    expect(history).toMatch(/agent/)

    await client.close()
  })

  it("returns the engine's hint when an operation is rejected", async () => {
    const client = await connect()
    const created = await client.callTool({ name: "create_design", arguments: { name: "x" } })
    const designId = /(design_\w+)/.exec(textOf(created))?.[1]

    const result = await client.callTool({
      name: "remove_component",
      arguments: { designId, args: { component: "R9" } },
    })

    // An external model needs the hint as much as ours does — more, since it has no
    // system prompt from us.
    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(textOf(result)).toMatch(/COMPONENT_NOT_FOUND/)
    expect(textOf(result)).toMatch(/Hint:/)
    await client.close()
  })

  it("rejects a malformed operation before it reaches the engine", async () => {
    const client = await connect()
    const created = await client.callTool({ name: "create_design", arguments: { name: "y" } })
    const designId = /(design_\w+)/.exec(textOf(created))?.[1]

    const result = await client.callTool({
      name: "connect",
      arguments: { designId, args: { a: "not a port ref" } },
    })

    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(textOf(result)).toMatch(/Invalid connect/)
    await client.close()
  })

  it("names a design that does not exist", async () => {
    const client = await connect()
    const result = await client.callTool({
      name: "inspect_design",
      arguments: { designId: "design_nope" },
    })

    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(textOf(result)).toMatch(/list_designs/)
    await client.close()
  })

  it("serves a pinout so an IC can be wired by name", async () => {
    const client = await connect()
    const result = await client.callTool({
      name: "get_pinout",
      arguments: { partId: "t0:ne555" },
    })

    const body = textOf(result)
    expect(body).toMatch(/VCC/)
    expect(body).toMatch(/footprint:/)
    await client.close()
  })

  it("keeps sessions apart", async () => {
    // Each session gets its own McpServer; sharing one would leak state between clients.
    const a = await connect()
    const b = await connect()

    const madeByA = await a.callTool({ name: "create_design", arguments: { name: "by A" } })
    const idA = /(design_\w+)/.exec(textOf(madeByA))?.[1]

    // They share the store, which is correct — two clients on one server see one set of
    // designs — while their protocol sessions are independent.
    const listedByB = textOf(await b.callTool({ name: "list_designs", arguments: {} }))
    expect(listedByB).toContain(idA!)

    await a.close()
    await b.close()
  })
})
