#!/usr/bin/env node
/**
 * SYNTRIX as a local MCP server, over stdio.
 *
 * This is what Claude Desktop and Cursor launch. Add to the client's MCP config:
 *
 * ```json
 * {
 *   "mcpServers": {
 *     "syntrix": {
 *       "command": "node",
 *       "args": ["D:/Projects/syntix/apps/api/dist/stdio-mcp.js"],
 *       "env": { "MONGO_URL": "mongodb://127.0.0.1:27017/vikronix_syntrix" }
 *     }
 *   }
 * }
 * ```
 *
 * **Nothing may be written to stdout except protocol messages.** stdout *is* the
 * transport: a stray `console.log` corrupts the stream and the client disconnects with an
 * error that looks nothing like its cause. Every diagnostic here goes to stderr, which the
 * client shows in its logs.
 *
 * With no `MONGO_URL` this runs on the in-memory store, which is useful for trying the
 * tools out and loses everything when the client closes. Point it at the same database
 * the web app uses and both see the same designs.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { t0Resolver } from "@syntrix/parts"
import { createMcpServer } from "./mcp"
import { MemoryDesignStore, type DesignStore } from "./store"
import { MongoDesignStore } from "./mongo-store"
import { connectMongo, databaseNameFrom } from "./mongo"

/** stderr, always. See the note above about stdout. */
const log = (message: string): void => {
  process.stderr.write(`[syntrix-mcp] ${message}\n`)
}

const selectStore = async (): Promise<DesignStore> => {
  const url = process.env["MONGO_URL"]
  const ctx = { resolvePart: t0Resolver }

  if (!url) {
    log("MONGO_URL is not set — designs are in memory and will not persist")
    return new MemoryDesignStore(ctx)
  }

  const { problem } = databaseNameFrom(url)
  if (problem) {
    log(`MONGO_URL is not usable: ${problem}`)
    log("falling back to an in-memory store")
    return new MemoryDesignStore(ctx)
  }

  try {
    const mongo = await connectMongo({
      url,
      ...(process.env["MONGO_DNS_SERVERS"] ? { dnsServers: process.env["MONGO_DNS_SERVERS"] } : {}),
    })
    const store = new MongoDesignStore(
      { designs: mongo.collection("designs"), operations: mongo.collection("operations") },
      ctx,
    )
    await store.ensureIndexes()
    log(`connected to mongo database "${mongo.db.databaseName}"`)
    return store
  } catch (cause) {
    // Falling back rather than exiting: an MCP client that cannot start its server shows
    // the user nothing useful, and read-only exploration still works in memory.
    log(`could not reach MongoDB (${cause instanceof Error ? cause.message : cause})`)
    log("falling back to an in-memory store")
    return new MemoryDesignStore(ctx)
  }
}

const main = async (): Promise<void> => {
  const store = await selectStore()
  const server = createMcpServer({ store, version: process.env["npm_package_version"] ?? "0.1.0" })

  const transport = new StdioServerTransport()
  await server.connect(transport)

  log("ready on stdio")
}

await main()
