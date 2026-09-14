/**
 * Background worker.
 *
 * Owns the jobs that must not block an HTTP request: exports (KiCad, Gerber), parts
 * indexing, long simulations, and Freerouting runs.
 *
 * M0 ships the process, its health endpoint and the queue names. Processors land with
 * the milestones that need them.
 */

import { createServer } from "node:http"

const PORT = Number(process.env.WORKER_HEALTH_PORT ?? 3023)
const startedAt = Date.now()

/** Queue names are declared here so the API and worker cannot disagree on a string. */
export const QUEUES = {
  export: "syntrix:export",
  index: "syntrix:index",
  sim: "syntrix:sim",
  route: "syntrix:route",
} as const

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES]

/**
 * Health for the worker is "can I reach the things I need to do work?" — a worker that
 * is running but cannot reach Redis is not healthy, it is silently idle.
 */
const health = () => ({
  status: "ok" as const,
  service: "worker",
  version: "0.1.0",
  uptimeSec: Math.round((Date.now() - startedAt) / 1000),
  queues: Object.values(QUEUES),
  processors: 0,
})

const server = createServer((req, res) => {
  if (req.url === "/health" || req.url === "/live") {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify(health()))
    return
  }
  res.writeHead(404, { "Content-Type": "application/json" })
  res.end(JSON.stringify({ error: "not found" }))
})

server.listen(PORT, () => {
  console.log(`[worker] health endpoint on :${PORT}`)
  console.log(`[worker] queues declared: ${Object.values(QUEUES).join(", ")}`)
})

const shutdown = (signal: string) => {
  console.log(`[worker] ${signal} received, draining`)
  // Processors get a graceful close here once they exist, so an in-flight export is not
  // lost on deploy.
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(1), 15_000).unref()
}
process.on("SIGTERM", () => shutdown("SIGTERM"))
process.on("SIGINT", () => shutdown("SIGINT"))
