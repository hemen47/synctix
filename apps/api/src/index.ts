/**
 * Server bootstrap. Everything testable lives in app.ts; this file only binds a port,
 * chooses a store, and wires process-level concerns.
 */

import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createApp } from "./app"
import { createPartsStack } from "./parts-stack"
import type { DependencyHealth } from "./health"
import { MemoryDesignStore, type DesignStore } from "./store"
import { MongoDesignStore } from "./mongo-store"
import { connectMongo, databaseNameFrom, type MongoConnection } from "./mongo"

/**
 * One process, one port: the built server answers /api, /mcp *and* the web app. In
 * development it sits on an internal port instead, behind the Vite dev server, which owns
 * the public port and proxies here — so the browser only ever sees one address (ADR-0029).
 *
 * Which of the two this is comes from the bundler, not from NODE_ENV. `SYNTRIX_SERVE_WEB`
 * is defined at build time, so it is set exactly when this file *is* the built artifact.
 * Keying off NODE_ENV instead made `pnpm start` bind the development port whenever a .env
 * happened to say `development`, which is the common case and a miserable way to find out.
 */
const servesWebApp = process.env.SYNTRIX_SERVE_WEB === "1" || Boolean(process.env.WEB_DIST)

const PORT = Number(
  process.env.PORT ??
    (servesWebApp ? (process.env.WEB_PORT ?? 3015) : (process.env.API_PORT ?? 3016)),
)
const VERSION = process.env.npm_package_version ?? "0.1.0"
const startedAt = Date.now()

// Two levels up reaches apps/ from either src/ (tsx) or dist/ (the bundle), so the built
// app is found the same way in both.
const WEB_DIST =
  process.env.WEB_DIST ??
  resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "dist")

/**
 * The parts stack, built before the store because the store needs its resolver.
 *
 * One instance for the process: the same library backs the palette, the agent, MCP and
 * core's own `partRef` resolution. Building a second one here is exactly the bug this
 * module exists to prevent — a custom part that saves and searches but cannot be placed.
 */
const partsStack = createPartsStack()

/**
 * Pick a store.
 *
 * With `MONGO_URL` set, designs persist. Without it, they live in memory for the life of
 * the process — which is a supported way to run, not a degraded one: it is what the
 * Playwright suite drives, and it means a new contributor can run the stack before
 * installing a database.
 *
 * A configured-but-unreachable database is different, and is reported loudly. Falling
 * back silently there would mean losing someone's work to a typo in a connection string.
 */
const selectStore = async (): Promise<{ store: DesignStore; mongo?: MongoConnection }> => {
  const url = process.env.MONGO_URL
  const ctx = { resolvePart: partsStack.resolvePart }

  if (!url) {
    console.log("[api] MONGO_URL is not set — designs are in memory and will not persist")
    return { store: new MemoryDesignStore(ctx) }
  }

  // Checked before connecting: a database name with a `/` in it connects happily and then
  // fails on every query, which is a miserable way to find out.
  const { problem } = databaseNameFrom(url)
  if (problem) {
    console.error(`[api] MONGO_URL is not usable: ${problem}`)
    console.error("[api] refusing to start with a connection string that cannot work")
    process.exit(1)
  }

  try {
    const mongo = await connectMongo({
      url,
      ...(process.env.MONGO_DNS_SERVERS ? { dnsServers: process.env.MONGO_DNS_SERVERS } : {}),
    })

    const store = new MongoDesignStore(
      {
        designs: mongo.collection("designs"),
        operations: mongo.collection("operations"),
      },
      ctx,
    )
    await store.ensureIndexes()

    console.log(`[api] mongo connected — database "${mongo.db.databaseName}"`)
    return { store, mongo }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    console.error(`[api] could not reach MongoDB: ${message}`)
    if (url.startsWith("mongodb+srv://") && /ECONNREFUSED|ENOTFOUND|querySrv/i.test(message)) {
      // The error names DNS, not Mongo, which sends people looking in the wrong place.
      console.error(
        "[api] a mongodb+srv:// URL needs a working DNS resolver for the SRV lookup. " +
          "If this machine's resolver is a local stub, set MONGO_DNS_SERVERS=8.8.8.8,8.8.4.4",
      )
    }
    process.exit(1)
  }
}

const { store, mongo } = await selectStore()

/**
 * MongoDB is the only dependency this process has, and the only one whose absence means
 * it cannot do its job — so it is *required*, and /health returns 503 when it is down.
 *
 * Running in memory is different. That is a deliberate choice, so it reports `disabled`
 * and leaves the stack healthy (ADR-0027).
 */
const healthProbes = async (): Promise<DependencyHealth[]> => {
  if (!mongo) {
    return [
      { name: "mongo", status: "disabled", detail: "MONGO_URL is not set — designs are in memory" },
    ]
  }

  const started = Date.now()
  try {
    await mongo.db.command({ ping: 1 })
    return [{ name: "mongo", status: "up", latencyMs: Date.now() - started }]
  } catch (cause) {
    return [
      {
        name: "mongo",
        status: "down",
        latencyMs: Date.now() - started,
        detail: cause instanceof Error ? cause.message : "unreachable",
      },
    ]
  }
}

const app = createApp({
  healthProbes,
  version: VERSION,
  startedAt,
  store,
  // The same stack the store's resolver came from, so the palette and the engine agree
  // about which parts exist.
  partsStack,
  ...(process.env.SYNTRIX_API_KEY ? { apiKey: process.env.SYNTRIX_API_KEY } : {}),
  ...(process.env.MCP_BEARER_TOKEN ? { mcpBearerToken: process.env.MCP_BEARER_TOKEN } : {}),
  ...(process.env.PUBLIC_ORIGIN ? { publicOrigin: process.env.PUBLIC_ORIGIN } : {}),
  // Development leaves this unset: Vite serves the app there, with HMR.
  ...(servesWebApp ? { webDist: WEB_DIST } : {}),
})

const server = app.listen(PORT, () => {
  const serves = servesWebApp ? "app + api + mcp" : "api + mcp"
  console.log(
    `[api] http://localhost:${PORT} — ${serves} (${process.env.NODE_ENV ?? "development"})`,
  )
})

// Finish in-flight requests on SIGTERM rather than dropping them.
const shutdown = (signal: string) => {
  console.log(`[api] ${signal} received, shutting down`)
  server.close(() => {
    void mongo?.close().finally(() => process.exit(0))
    if (!mongo) process.exit(0)
  })
  setTimeout(() => process.exit(1), 10_000).unref()
}
process.on("SIGTERM", () => shutdown("SIGTERM"))
process.on("SIGINT", () => shutdown("SIGINT"))
