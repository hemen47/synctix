/**
 * Design summary for the LLM.
 *
 * A design is thousands of elements; a context window is not a data store. The agent
 * gets a netlist-shaped digest — components with values, nets with their members — which
 * is what it actually reasons about. Coordinates, symbol geometry and PCB elements are
 * omitted entirely: the model must not think in coordinates (principle 4), so showing it
 * any would be counterproductive as well as wasteful.
 */

import type { Design } from "./types"
import { buildIndex, describePort, electricalNets } from "./index-view"
import { ftypeSpec } from "./elements"

export interface SummarizeOptions {
  /**
   * Soft ceiling. The summary degrades gracefully: components and nets are truncated
   * with a count of what was elided, rather than the text being cut mid-line.
   */
  budgetTokens?: number
  /** Include the sidecar's placement constraints and agent notes. */
  includeMeta?: boolean
}

/** Rough token estimate. Good enough to decide what to drop; not a tokenizer. */
const estimateTokens = (text: string): number => Math.ceil(text.length / 4)

export const summarizeForLLM = (design: Design, options: SummarizeOptions = {}): string => {
  const budget = options.budgetTokens ?? 2000
  const view = buildIndex(design.circuit)

  if (view.components.size === 0) {
    return "The design is empty — no components yet."
  }

  const header = `Design ${design.id} (version ${design.version}): ${view.components.size} component(s), ${view.nets.size} named net(s).`

  const componentLines = [...view.components.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((component) => {
      const spec = ftypeSpec(component.ftype ?? "")
      const record = component as unknown as Record<string, unknown>
      const display = spec?.valueProp ? record[`display_${spec.valueProp}`] : undefined
      const value = display ?? (spec?.valueProp ? record[spec.valueProp] : undefined)
      const pins = view.portsByComponent.get(component.source_component_id)?.length ?? 0

      const partRef = design.meta[component.source_component_id]?.partRef
      return `  ${component.name}: ${component.ftype}${value !== undefined ? ` = ${value}` : ""}, ${pins} pin(s)${partRef ? ` [part ${partRef}]` : ""}`
    })

  // Nets are listed by their members, which is how an engineer reads a netlist and how
  // the model can spot a missing connection.
  const netLines = electricalNets(view)
    .filter((net) => net.ports.size > 0)
    .map((net) => {
      const members = [...net.ports]
        .map((id) => view.ports.get(id))
        .filter((p) => p !== undefined)
        .map((p) => describePort(view, p))
        .sort()
      return `  ${net.name ?? "(unnamed)"}: ${members.join(", ")}`
    })
    .sort()

  const sections: string[] = [
    header,
    "",
    "Components:",
    ...componentLines,
    "",
    "Nets:",
    ...netLines,
  ]

  if (options.includeMeta) {
    const constraintLines = Object.entries(design.meta)
      .filter(([, entry]) => (entry.constraints?.length ?? 0) > 0 || (entry.notes?.length ?? 0) > 0)
      .map(([id, entry]) => {
        const name = view.components.get(id)?.name ?? view.nets.get(id)?.name ?? id
        const parts: string[] = []
        if (entry.constraints?.length) {
          parts.push(entry.constraints.map((c) => c.kind).join(", "))
        }
        if (entry.notes?.length) parts.push(entry.notes.join("; "))
        return `  ${name}: ${parts.join(" | ")}`
      })

    if (constraintLines.length > 0) {
      sections.push("", "Placement hints and notes:", ...constraintLines)
    }
  }

  const full = sections.join("\n")
  if (estimateTokens(full) <= budget) return full

  // Over budget: keep the header and net list (connectivity is what the model reasons
  // about) and truncate the component list, reporting how much was dropped.
  const keep = Math.max(10, Math.floor(componentLines.length / 2))
  const truncated = [
    header,
    "",
    "Components (truncated):",
    ...componentLines.slice(0, keep),
    `  … and ${componentLines.length - keep} more component(s).`,
    "",
    "Nets:",
    ...netLines.slice(0, 60),
    netLines.length > 60 ? `  … and ${netLines.length - 60} more net(s).` : "",
  ].filter(Boolean)

  return truncated.join("\n")
}
