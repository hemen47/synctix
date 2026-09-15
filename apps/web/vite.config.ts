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

  return {
    plugins: [react()],
    server: {
      port: Number(env["WEB_PORT"] ?? process.env["WEB_PORT"] ?? 3016),
      host: true,
      // In dev the browser talks to Vite, which forwards /api to the API. In production
      // Caddy does the same routing, so the app's fetch paths are identical in both.
      proxy: {
        "/api": {
          target: process.env["API_PROXY_TARGET"] ?? `http://localhost:${env["API_PORT"] ?? 3017}`,
          changeOrigin: true,
          configure: (proxy) => {
            // The API key is attached here, by the dev server, rather than by the app.
            //
            // Principle 7: secrets exist server-side only. Shipping the key to the
            // browser would put it in devtools, in the bundle and in anyone's page
            // source. The proxy is the server side of this hop, so it is where the
            // header belongs — and it mirrors production, where the reverse proxy does
            // the same thing and the app again sends nothing.
            const apiKey = env["SYNTRIX_API_KEY"] ?? process.env["SYNTRIX_API_KEY"]
            if (!apiKey) return

            proxy.on("proxyReq", (proxyReq) => {
              if (!proxyReq.getHeader("x-api-key")) proxyReq.setHeader("x-api-key", apiKey)
            })
          },
        },
      },
    },
    preview: { port: Number(env["WEB_PORT"] ?? 3016), host: true },
    build: { outDir: "dist", sourcemap: true },
  }
})
