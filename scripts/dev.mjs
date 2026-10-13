/**
 * The development stack: the API and the Vite dev server, one command, one URL.
 *
 * This replaces `turbo run dev`. Turbo could not be used here at all — on Windows, pnpm
 * spawning turbo's Node shim with a console attached fastfails the process (exit
 * 0xC0000409) before any task starts, for `dev`, `build`, `test` and `lint` alike.
 * See ADR-0028.
 *
 * Two deliberate choices:
 *
 * - **Children are spawned as `node <cli entry>`, not through the `.bin` shims.** On
 *   Windows a `.bin` entry is a `.CMD` file, so every child would carry an extra
 *   `cmd.exe` in its tree — which is exactly what makes Ctrl+C leave orphaned `vite` and
 *   `tsx` processes holding the ports.
 * - **Shutdown kills the process *tree*.** `taskkill /T` on Windows, the process group
 *   elsewhere. Killing a bare pid on Windows leaves grandchildren running, and the next
 *   `pnpm dev` then fails with EADDRINUSE on a port nothing appears to own.
 */

import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join, resolve } from "node:path"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const isWindows = process.platform === "win32"

const RESET = "\x1b[0m"

/** Vite is the one the browser talks to; it proxies /api and /mcp to the API. */
const WEB_PORT = process.env.WEB_PORT ?? "3015"
const API_PORT = process.env.API_PORT ?? "3016"

const allTargets = [
  {
    name: "api",
    color: "\x1b[36m",
    cwd: join(repoRoot, "apps", "api"),
    args: [
      join(repoRoot, "apps", "api", "node_modules", "tsx", "dist", "cli.mjs"),
      "watch",
      "--env-file-if-exists=../../.env",
      "src/index.ts",
    ],
  },
  {
    name: "web",
    color: "\x1b[35m",
    cwd: join(repoRoot, "apps", "web"),
    args: [join(repoRoot, "apps", "web", "node_modules", "vite", "bin", "vite.js")],
  },
]

// `node scripts/dev.mjs api` runs one half; no argument runs both.
const only = process.argv.slice(2).filter((a) => !a.startsWith("-"))
const targets = only.length ? allTargets.filter((t) => only.includes(t.name)) : allTargets

if (targets.length === 0) {
  process.stderr.write(`[dev] no such target: ${only.join(", ")} (expected api and/or web)\n`)
  process.exit(1)
}

const children = new Map()
let shuttingDown = false

/** Prefix every line, so two interleaved streams stay readable. */
const pipe = (stream, { name, color }) => {
  let carry = ""
  stream.setEncoding("utf8")
  stream.on("data", (chunk) => {
    const lines = (carry + chunk).split("\n")
    carry = lines.pop() ?? ""
    for (const line of lines) process.stdout.write(`${color}${name}${RESET} | ${line}\n`)
  })
  stream.on("end", () => {
    if (carry) process.stdout.write(`${color}${name}${RESET} | ${carry}\n`)
  })
}

const shutdown = (code) => {
  if (shuttingDown) return
  shuttingDown = true

  for (const child of children.values()) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    try {
      if (isWindows) {
        // /T takes the children with it; without it vite and tsx survive the parent.
        spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" })
      } else {
        process.kill(-child.pid, "SIGTERM")
      }
    } catch {
      // Already gone between the check and the kill; nothing left to clean up.
    }
  }

  // Give the kills a moment to land before going down with them.
  setTimeout(() => process.exit(code), 500).unref()
}

for (const target of targets) {
  const child = spawn(process.execPath, target.args, {
    cwd: target.cwd,
    env: { ...process.env, WEB_PORT, API_PORT },
    stdio: ["ignore", "pipe", "pipe"],
    // A process group on POSIX, so one kill reaches the whole subtree.
    detached: !isWindows,
  })

  children.set(target.name, child)
  pipe(child.stdout, target)
  pipe(child.stderr, target)

  child.on("exit", (code, signal) => {
    if (shuttingDown) return
    // Half a stack looks alive but is not. Take both down, so the failure is visible.
    process.stdout.write(`\n[dev] ${target.name} exited (${signal ?? code}) — stopping the rest\n`)
    shutdown(typeof code === "number" && code !== 0 ? code : 1)
  })
}

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => shutdown(0))

process.stdout.write(
  targets.length === allTargets.length
    ? `[dev] http://localhost:${WEB_PORT} — /api and /mcp proxied to the API on :${API_PORT}\n`
    : `[dev] running ${targets.map((t) => t.name).join(" and ")} only\n`,
)
