/**
 * Server bootstrap. Everything testable lives in app.ts; this file only binds a port,
 * chooses a store, and wires process-level concerns.
 */

import { t0Resolver } from "@syntrix/parts"
import { createApp } from "./app"
import { MemoryDesignStore, type DesignStore } from "./store"
import { MongoDesignStore } from "./mongo-store"
import { connectMongo, databaseNameFrom, type MongoConnection } from "./mongo"

const PORT = Number(process.env.API_PORT ?? 3017)
const VERSION = process.env.npm_package_version ?? "0.1.0"
const startedAt = Date.now()

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
  const ctx = { resolvePart: t0Resolver }

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

const app = createApp({
  version: VERSION,
  startedAt,
  store,
  ...(process.env.SYNTRIX_API_KEY ? { apiKey: process.env.SYNTRIX_API_KEY } : {}),
  ...(process.env.MCP_BEARER_TOKEN ? { mcpBearerToken: process.env.MCP_BEARER_TOKEN } : {}),
  ...(process.env.PUBLIC_ORIGIN ? { publicOrigin: process.env.PUBLIC_ORIGIN } : {}),
})

const server = app.listen(PORT, () => {
  console.log(`[api] listening on :${PORT} (${process.env.NODE_ENV ?? "development"})`)
})

// Compose sends SIGTERM on `down`; finish in-flight requests rather than dropping them.
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
