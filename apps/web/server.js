/**
 * Production static server for the built SPA.
 *
 * Deliberately dependency-free: this process sits behind Caddy, which already handles
 * TLS, compression and routing, so all it owes anyone is correct static serving, SPA
 * fallback, and a health endpoint for the container healthcheck.
 */

import { createServer } from "node:http"
import { createReadStream } from "node:fs"
import { stat } from "node:fs/promises"
import { join, extname, normalize, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const PORT = Number(process.env.WEB_PORT ?? 3016)
const ROOT = resolve(fileURLToPath(new URL("./dist", import.meta.url)))

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".map": "application/json; charset=utf-8",
}

/**
 * Resolve a URL path to a file inside ROOT, or null if it escapes.
 * Without the containment check, `/../../etc/passwd` would be served.
 */
const resolveSafe = (urlPath) => {
  const decoded = decodeURIComponent(urlPath.split("?")[0])
  const candidate = resolve(join(ROOT, normalize(decoded)))
  return candidate === ROOT || candidate.startsWith(ROOT + "\\") || candidate.startsWith(ROOT + "/")
    ? candidate
    : null
}

const sendFile = (res, path, status = 200) => {
  const type = MIME[extname(path)] ?? "application/octet-stream"
  // Hashed assets are immutable; index.html must never be cached or a deploy is
  // invisible until the user hard-refreshes.
  const cache = path.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable"

  res.writeHead(status, { "Content-Type": type, "Cache-Control": cache })
  createReadStream(path).pipe(res)
}

const server = createServer(async (req, res) => {
  if (req.url === "/health" || req.url === "/live") {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ status: "ok", service: "web" }))
    return
  }

  const path = resolveSafe(req.url ?? "/")
  if (!path) {
    res.writeHead(403).end("Forbidden")
    return
  }

  try {
    const info = await stat(path)
    if (info.isFile()) return sendFile(res, path)
  } catch {
    // Fall through to the SPA entry point.
  }

  // SPA fallback: every unmatched route is client-side routing, not a 404.
  try {
    await stat(join(ROOT, "index.html"))
    sendFile(res, join(ROOT, "index.html"))
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" })
    res.end("Build missing. Run `pnpm --filter @syntrix/web build` first.")
  }
})

server.listen(PORT, () => {
  console.log(`[web] serving ${ROOT} on :${PORT}`)
})

const shutdown = (signal) => {
  console.log(`[web] ${signal} received, shutting down`)
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(1), 10_000).unref()
}
process.on("SIGTERM", () => shutdown("SIGTERM"))
process.on("SIGINT", () => shutdown("SIGINT"))
