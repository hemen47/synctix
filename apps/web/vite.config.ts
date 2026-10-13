import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { defineConfig, loadEnv } from "vite"
import react from "@vitejs/plugin-react"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, "..", "..")

export default defineConfig(({ mode }) => {
  // The repo's own .env, with no VITE_ prefix filter. Nothing from it is exposed to the
  // browser — it is read here so the dev server can act on it, which is the whole point
  // of the header injection below.
  const env = loadEnv(mode, repoRoot, "")
  const pick = (key, fallback) => env[key] ?? process.env[key] ?? fallback

  // One port for the browser, in development and in production alike. Here Vite serves
  // the app and forwards /api and /mcp to the API; in production the API process serves
  // the built assets itself on this same port. The app's fetch paths never change, and
  // there is no proxy in front of either (ADR-0029).
  const webPort = Number(pick("WEB_PORT", 3015))
  const apiTarget = pick("API_PROXY_TARGET", `http://localhost:${pick("API_PORT", 3016)}`)

  /**
   * The API key is attached here, by the dev server, rather than by the app.
   *
   * Principle 8: secrets exist server-side only. Shipping the key to the browser would
   * put it in devtools, in the bundle and in anyone's page source. The proxy is the
   * server side of this hop, so it is where the header belongs.
   */
  const injectHeader = (header, value) => (proxy) => {
    if (!value) return
    proxy.on("proxyReq", (proxyReq) => {
      if (!proxyReq.getHeader(header)) proxyReq.setHeader(header, value)
    })
  }

  return {
    plugins: [react()],
    server: {
      port: webPort,
      host: true,
      proxy: {
        "/api": {
          target: apiTarget,
          changeOrigin: true,
          configure: injectHeader("x-api-key", pick("SYNTRIX_API_KEY", "")),
        },
        // Health and liveness answer from the API in production, where it serves this
        // port itself. Proxying them keeps dev identical rather than letting the SPA
        // fallback answer /health with index.html.
        "/health": { target: apiTarget, changeOrigin: true },
        "/live": { target: apiTarget, changeOrigin: true },
        // Streamable HTTP, for an MCP client pointed at this one port.
        "/mcp": {
          target: apiTarget,
          changeOrigin: true,
          configure: injectHeader(
            "authorization",
            (() => {
              const token = pick("MCP_BEARER_TOKEN", "")
              return token ? `Bearer ${token}` : ""
            })(),
          ),
        },
      },
    },
    preview: { port: webPort, host: true },
    build: { outDir: "dist", sourcemap: true },
  }
})
