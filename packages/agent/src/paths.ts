/**
 * Where the agent's own files live.
 *
 * `config/models.yaml` and the vendored tscircuit skill were both resolved against
 * `process.cwd()`, which is the repo root only when someone runs `pnpm test` or
 * `pnpm dev` from it. It is *not* the root in the two cases that matter: `scripts/dev.mjs`
 * spawns the api with `cwd: apps/api`, and vitest runs each package from its own
 * directory. The agent then reported "config/models.yaml could not be read" on a machine
 * where the file was plainly there — a failure that looks like a missing API key and is
 * not one.
 *
 * Walking up for the workspace marker fixes it for every caller at once, and keeps
 * working when the server is bundled into `apps/api/dist/` (ADR-0030), which is a third
 * directory again.
 */

import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/** The file that marks the top of this workspace and nothing else in the tree. */
const MARKER = "pnpm-workspace.yaml"

/**
 * The repo root, found by walking up from a starting directory.
 *
 * Starts from this module rather than from `process.cwd()`: the module's location is a
 * fact about the installation, while the working directory is a fact about how someone
 * happened to launch it. Falls back to the cwd when no marker is found, which is the
 * right answer for an installation that is not a checkout at all.
 */
export const findRepoRoot = (from?: string): string => {
  const start = from ?? dirname(fileURLToPath(import.meta.url))

  let current = resolve(start)
  for (;;) {
    if (existsSync(join(current, MARKER))) return current
    const parent = dirname(current)
    if (parent === current) return process.cwd()
    current = parent
  }
}

/** `config/models.yaml`, wherever the process was started from. */
export const modelsConfigPath = (): string => join(findRepoRoot(), "config", "models.yaml")

/** The vendored tscircuit AI skill, fetched at build time. */
export const tscircuitSkillDir = (): string =>
  join(findRepoRoot(), "packages", "agent", "prompts", "tscircuit-skill")
