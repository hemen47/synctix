import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.WEB_PORT ?? 3016),
    host: true,
    // In dev the browser talks to Vite, which forwards /api to the API container. In
    // production Caddy does the same routing, so the app's fetch paths are identical in
    // both environments.
    proxy: {
      "/api": {
        target: process.env.API_PROXY_TARGET ?? "http://localhost:3017",
        changeOrigin: true,
      },
    },
  },
  preview: { port: Number(process.env.WEB_PORT ?? 3016), host: true },
  build: { outDir: "dist", sourcemap: true },
})
