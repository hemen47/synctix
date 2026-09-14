/**
 * Server bootstrap. Everything testable lives in app.ts; this file only binds a port
 * and wires process-level concerns.
 */

import { createApp } from "./app"

const PORT = Number(process.env.API_PORT ?? 3017)
const VERSION = process.env.npm_package_version ?? "0.1.0"
const startedAt = Date.now()

const app = createApp({
  version: VERSION,
  startedAt,
  apiKey: process.env.SYNTRIX_API_KEY,
  publicOrigin: process.env.PUBLIC_ORIGIN,
})

const server = app.listen(PORT, () => {
  console.log(`[api] listening on :${PORT} (${process.env.NODE_ENV ?? "development"})`)
})

// Compose sends SIGTERM on `down`; finish in-flight requests rather than dropping them.
const shutdown = (signal: string) => {
  console.log(`[api] ${signal} received, shutting down`)
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(1), 10_000).unref()
}
process.on("SIGTERM", () => shutdown("SIGTERM"))
process.on("SIGINT", () => shutdown("SIGINT"))
