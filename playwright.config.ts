/**
 * Playwright, against the real stack.
 *
 * Both servers are started by Playwright rather than by Docker: these tests are about the
 * editor, not about the deployment, and needing a container running to check that a drag
 * emits a `move_component` would make them the kind of test nobody runs.
 *
 * The api runs with its in-memory store — the same code path a development stack with no
 * `MONGO_URL` takes, so this exercises a supported configuration rather than a test-only
 * one.
 */

import { defineConfig, devices } from "@playwright/test"

const WEB_PORT = 4173
const API_PORT = 4175

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false, // one API process, one in-memory store
  forbidOnly: Boolean(process.env["CI"]),
  retries: process.env["CI"] ? 1 : 0,
  workers: 1,
  reporter: process.env["CI"] ? [["github"], ["html", { open: "never" }]] : [["list"]],

  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  webServer: [
    {
      command: `pnpm --filter @syntrix/api dev`,
      port: API_PORT,
      reuseExistingServer: !process.env["CI"],
      env: { API_PORT: String(API_PORT), NODE_ENV: "test", LOG_LEVEL: "warn" },
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      // `vite dev` rather than a built bundle: a failing assertion should point at a line
      // of source, and the build is covered by CI separately.
      command: `pnpm --filter @syntrix/web dev --port ${WEB_PORT} --strictPort`,
      port: WEB_PORT,
      reuseExistingServer: !process.env["CI"],
      env: { API_PROXY_TARGET: `http://localhost:${API_PORT}`, WEB_PORT: String(WEB_PORT) },
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
})
