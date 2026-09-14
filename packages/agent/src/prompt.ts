/**
 * The system prompt.
 *
 * Assembled rather than written as one blob, because the pieces have different lifetimes:
 * the house rules are ours and change when we learn something; the tscircuit skill is
 * vendored from upstream and changes when they publish; the design summary and the parts
 * digest change every turn. Keeping them apart means a prompt regression can be traced to
 * one of them.
 */

import { readFileSync } from "node:fs"
import { existsSync } from "node:fs"
import { join } from "node:path"

/**
 * House rules.
 *
 * Every line here exists because of a way circuits actually go wrong, not because it
 * sounded like good practice. A rule a model cannot act on is noise in the context.
 */
export const HOUSE_RULES = `## How to design here

- **Ground first.** Every circuit needs a ground reference. Create a net marked
  \`isGround\` and connect to it explicitly; ERC will fail the design without one, and a
  simulation without a reference node fails in a way that looks like a circuit problem.
- **Decouple every IC.** A 100nF capacitor from each supply pin to ground, placed with a
  \`decoupling_for\` hint naming the pin. This is the most common omission in a design
  that "works in simulation" and not on a bench.
- **Wire power and ground through named nets**, not pin-to-pin chains. A chain is
  electrically the same and unreadable, and it hides a missing connection.
- **Look up a pinout before wiring an IC.** Call \`get_pinout\`. Guessing which pin is VCC
  is how boards are destroyed.
- **Prefer a catalog part to a bare ftype.** A part brings a verified footprint, a real
  pinout and a SPICE model. If you use a part whose footprint is marked unverified, say so
  in your final message.
- **Do not invent a part.** If the catalog has nothing suitable, say what is missing and
  ask — an exotic part chosen silently is a board that cannot be assembled.
- **You never place anything.** Positions are computed. Express intent with
  \`place_hint\` and let layout do the geometry.

## Finishing

- **Run \`run_erc\` before you finish.** Always. Report what it says, including warnings
  you decided not to act on and why.
- **Simulate when the request was about behaviour** — a corner frequency, a gain, a
  timing — and quote the measured number against what was asked for.
- Say plainly what you did not do, and why. A design review is worth more than a
  confident summary.`

/**
 * The tscircuit skill, trimmed.
 *
 * The upstream document is written for an agent with a shell and the `tsci` CLI. Ours has
 * neither: it has `generate_tsx_circuit`, which evaluates a snippet in-process with no
 * network and no package resolution. Sending the CLI sections unedited makes a model try
 * to run commands that do not exist, so the workflow and CLI parts are dropped and the
 * syntax and footprint parts — the reason to include it at all — are kept.
 */
export const loadTscircuitSkill = (root?: string): string => {
  const dir = root ?? join(process.cwd(), "packages", "agent", "prompts", "tscircuit-skill")

  const wanted = ["SYNTAX.md", "FOOTPRINTS.md", "BUS_LANES.md"]
  const parts: string[] = []

  for (const name of wanted) {
    const path = join(dir, name)
    if (!existsSync(path)) continue
    parts.push(
      readFileSync(path, "utf8")
        .replace(/^---[\s\S]*?---\n/, "")
        .trim(),
    )
  }

  if (parts.length === 0) return ""

  return [
    "## Writing tscircuit (for `generate_tsx_circuit`)",
    "",
    "The following is tscircuit's own documentation. Two adjustments for this environment:",
    "there is **no shell and no `tsci` CLI**, and **imports are not resolved** — use only",
    "built-in elements. Your snippet must call `circuit.add(<board>…</board>)`.",
    "",
    parts.join("\n\n---\n\n"),
  ].join("\n")
}

export interface PromptParts {
  /** What the design currently is, from `summarizeForLLM`. */
  designSummary?: string
  /** A short catalog digest, so the model knows what it can reach for. */
  partsDigest?: string
  /** The tscircuit skill, for TSX mode. Omitted in operations-only runs. */
  skill?: string
  /** Anything the caller wants to add for this run. */
  extra?: string
}

export const buildSystemPrompt = (parts: PromptParts = {}): string => {
  const sections = [
    `You are the engineering assistant inside SYNTRIX, a schematic and PCB tool.

You change designs by calling tools, which submit typed operations to one engine. You
cannot write files, run commands, or set coordinates. Every tool call is validated, and a
rejection comes back with a hint saying what to do instead — read it and fix the call
rather than trying the same thing again.`,
    HOUSE_RULES,
  ]

  if (parts.skill) sections.push(parts.skill)
  if (parts.partsDigest) sections.push(`## Parts available\n\n${parts.partsDigest}`)
  if (parts.designSummary) sections.push(`## The current design\n\n${parts.designSummary}`)
  if (parts.extra) sections.push(parts.extra)

  return sections.join("\n\n")
}
