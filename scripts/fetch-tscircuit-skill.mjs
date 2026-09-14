#!/usr/bin/env node
/**
 * Fetch the official tscircuit AI skill into `packages/agent/prompts/tscircuit-skill/`.
 *
 * TSX mode asks a model to write tscircuit, so the model should be told how by the people
 * who built it rather than by our paraphrase. github.com/tscircuit/skill is that document.
 *
 * Vendored rather than fetched at runtime, for three reasons: an agent run must not depend
 * on GitHub being reachable, the prompt a given release sends should be reproducible, and
 * a silent upstream change to the prompt is exactly the kind of thing that turns a passing
 * eval into a failing one with no diff to point at. Refresh deliberately:
 *
 *   node scripts/fetch-tscircuit-skill.mjs
 *
 * The licence file comes with it; check it before redistributing.
 */

import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const REPO = "tscircuit/skill"
const BRANCH = "main"

/**
 * What we take.
 *
 * Only the prompt-relevant documents. `CLI.md` is deliberately excluded: it is about
 * driving `tsci` from a shell, and our agent has no shell — telling it about commands it
 * cannot run invites it to try.
 */
const FILES = [
  "SKILL.md",
  "SYNTAX.md",
  "FOOTPRINTS.md",
  "WORKFLOW.md",
  "CHECKLIST.md",
  "BUS_LANES.md",
  "LICENSE",
]

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, "..", "packages", "agent", "prompts", "tscircuit-skill")

const fetchFile = async (name) => {
  const url = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${name}`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`)
  return response.text()
}

const main = async () => {
  await mkdir(outDir, { recursive: true })

  const fetched = []
  for (const name of FILES) {
    try {
      const body = await fetchFile(name)
      await writeFile(join(outDir, name), body, "utf8")
      fetched.push({ name, bytes: body.length })
      console.log(`  ${name.padEnd(16)} ${body.length} bytes`)
    } catch (error) {
      console.error(`  ${name.padEnd(16)} FAILED — ${error.message}`)
      process.exitCode = 1
    }
  }

  // A manifest, so a prompt regression can be traced to a refresh rather than guessed at.
  await writeFile(
    join(outDir, "MANIFEST.json"),
    `${JSON.stringify(
      {
        source: `https://github.com/${REPO}`,
        branch: BRANCH,
        fetchedAt: new Date().toISOString(),
        files: fetched,
        note: "Vendored deliberately. Refresh with scripts/fetch-tscircuit-skill.mjs.",
      },
      null,
      2,
    )}\n`,
    "utf8",
  )

  console.log(`\nWrote ${fetched.length} files to packages/agent/prompts/tscircuit-skill/`)
}

await main()
