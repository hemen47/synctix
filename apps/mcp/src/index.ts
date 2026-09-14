/**
 * MCP server, Streamable HTTP transport.
 *
 * Sits behind Caddy at /mcp with a bearer token. The stdio transport for local clients
 * (Claude Desktop, Cursor) lives in stdio.ts and shares the same tool registry, so a
 * tool is never implemented twice.
 *
 * M0 ships the transport, auth and health endpoint. Tools land at M9.
 */

import express, { type Request, type Response, type NextFunction } from "express"

const PORT = Number(process.env.MCP_PORT ?? 3018)
const BEARER = process.env.MCP_BEARER_TOKEN
const startedAt = Date.now()

const app = express()
app.disable("x-powered-by")
app.use(express.json({ limit: "16mb" }))

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    service: "mcp",
    version: "0.1.0",
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    transport: "streamable-http",
    // Reported so an operator can tell an unauthenticated server from a misconfigured
    // one without reading container logs.
    authConfigured: Boolean(BEARER),
    toolCount: 0,
  })
})

/**
 * Bearer auth for everything but health. An MCP server reachable from the public
 * internet without a token would hand anyone write access to every design.
 */
const requireBearer = (req: Request, res: Response, next: NextFunction): void => {
  if (!BEARER) {
    res.status(500).json({
      error: "MCP_BEARER_TOKEN is not set; refusing to serve tools unauthenticated.",
    })
    return
  }
  const header = req.header("authorization") ?? ""
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : undefined
  if (token !== BEARER) {
    res.status(401).json({ error: "Missing or invalid bearer token." })
    return
  }
  next()
}

app.use("/mcp", requireBearer)

app.all("/mcp", (_req: Request, res: Response) => {
  // Replaced at M9 by StreamableHTTPServerTransport wired to the shared tool registry.
  res.status(501).json({
    error: "MCP tools are not wired yet.",
    detail: "Transport and auth are in place; the tool registry lands at M9.",
  })
})

const server = app.listen(PORT, () => {
  console.log(`[mcp] listening on :${PORT} (streamable-http)`)
  if (!BEARER) console.warn("[mcp] MCP_BEARER_TOKEN is unset — tool endpoints will refuse requests")
})

const shutdown = (signal: string) => {
  console.log(`[mcp] ${signal} received, shutting down`)
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(1), 10_000).unref()
}
process.on("SIGTERM", () => shutdown("SIGTERM"))
process.on("SIGINT", () => shutdown("SIGINT"))
