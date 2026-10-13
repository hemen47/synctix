/**
 * The agent's `AgentBackend`: tool names in, engine results out.
 *
 * The loop knows three verbs — `submit`, `read`, `runErc` — and nothing about what a tool
 * is. This is where a name becomes work, and it is deliberately the *same* work the REST
 * API and the MCP server do: a mutating tool becomes an Operation and goes through
 * `store.submit`, which validates it in core and appends it to the log. The agent has no
 * private path into a design (principle 2), so "the agent broke my schematic" is a
 * question the operation log can answer, and an agent edit is undoable exactly like a
 * hand edit.
 *
 * Every result is *text*, because that is what goes back into a model's context. The
 * rejection path matters more than the success path: an engine error returns its own
 * `code`, `message` and `hint` verbatim, which is what lets a model fix its own call
 * instead of retrying the same one.
 */

import { AGENT_OPERATIONS, type AgentOperationName, type AgentBackend } from "@syntrix/agent"
import {
  formatErcForLlm,
  operationSchema,
  runErc,
  summarizeForLLM,
  type Operation,
} from "@syntrix/core"
import { type PartsIndex } from "@syntrix/parts"
import { err, ok, validationError, type Result, type ValidationError } from "@syntrix/shared"
import type { DesignStore } from "./store"

const MUTATING = new Set<string>(AGENT_OPERATIONS)

export interface AgentBackendDeps {
  store: DesignStore
  designId: string
  parts: PartsIndex
  /** Tags every operation the agent applies, so the log can be filtered by run. */
  runId: string
}

/**
 * Build the backend for one run against one design.
 *
 * Scoped per run rather than per process: the design id and run id are fixed for the
 * duration, which is what keeps `submit` from needing them as arguments and what makes
 * the operation log attributable afterwards.
 */
export const createAgentBackend = (deps: AgentBackendDeps): AgentBackend => {
  const { store, designId, parts, runId } = deps

  const submit = async (
    tool: string,
    input: unknown,
  ): Promise<Result<{ summary: string }, ValidationError[]>> => {
    if (tool === "generate_tsx_circuit") return compileAndMerge(deps, input)

    if (!MUTATING.has(tool)) {
      return err([
        validationError(
          "INVALID_OPERATION",
          `"${tool}" is not an operation.`,
          `Mutating tools are: ${[...MUTATING].join(", ")}, generate_tsx_circuit.`,
        ),
      ])
    }

    const fields = (input ?? {}) as Record<string, unknown>
    const parsed = operationSchema.safeParse({ type: tool as AgentOperationName, ...fields })
    if (!parsed.success) {
      // Zod's path is the difference between "the call was wrong" and "this field was
      // wrong", and the model can only act on the second.
      return err(
        parsed.error.issues.map((issue) =>
          validationError(
            "INVALID_OPERATION",
            `${issue.path.join(".") || "(root)"}: ${issue.message}`,
            `Check the argument shape for ${tool} and call it again.`,
          ),
        ),
      )
    }

    const result = await store.submit(designId, parsed.data as Operation, {
      actor: { kind: "agent", runId },
    })
    if (!result.ok) return result

    return ok({
      summary:
        `${tool} applied. The design is at version ${result.value.record.version} with ` +
        `${result.value.design.circuit.length} elements.`,
    })
  }

  const read = async (
    tool: string,
    input: unknown,
  ): Promise<Result<{ summary: string }, ValidationError[]>> => {
    const fields = (input ?? {}) as Record<string, unknown>

    switch (tool) {
      case "inspect_design": {
        const found = await store.get(designId)
        if (!found) return err([missing(designId)])
        return ok({
          summary: summarizeForLLM(found.design, {
            ...(typeof fields["budgetTokens"] === "number"
              ? { budgetTokens: fields["budgetTokens"] }
              : {}),
          }),
        })
      }

      case "run_erc": {
        const found = await store.get(designId)
        if (!found) return err([missing(designId)])
        return ok({ summary: formatErcForLlm(runErc(found.design)) })
      }

      case "search_parts": {
        const query = String(fields["query"] ?? "")
        if (query.length === 0) {
          return err([
            validationError("INVALID_OPERATION", "search_parts needs a query.", "Pass `query`."),
          ])
        }

        const limit = typeof fields["limit"] === "number" ? fields["limit"] : 10
        const hits = await parts.search(query, { limit })
        if (hits.length === 0) {
          return ok({
            summary:
              `Nothing matched "${query}". Try a broader term, or say what is missing ` +
              "rather than inventing a part.",
          })
        }

        return ok({
          summary: hits
            .map(
              (hit) =>
                `${hit.id}  ${hit.mpn ?? ""}  ${hit.package ?? hit.category}` +
                `${hit.footprintVerified ? "" : "  [footprint unverified]"}\n    ${hit.description}`,
            )
            .join("\n"),
        })
      }

      case "get_pinout": {
        const partId = String(fields["partId"] ?? "")
        const part = await parts.get(partId)
        if (!part) {
          return err([
            validationError(
              "ELEMENT_NOT_FOUND",
              `No part with id "${partId}".`,
              "Use search_parts to find a valid part id.",
            ),
          ])
        }

        return ok({
          summary: [
            `${part.id}${part.mpn ? ` (${part.mpn})` : ""} — ${part.description}`,
            `footprint: ${part.footprint.verification}`,
            "",
            ...part.pins.map(
              (pin) =>
                `  ${pin.number}. ${pin.name} [${pin.kind}]` +
                (pin.altNames.length > 0 ? `  aka ${pin.altNames.join(", ")}` : ""),
            ),
          ].join("\n"),
        })
      }

      case "simulate":
        return simulate(deps, fields)

      case "export": {
        const found = await store.get(designId)
        if (!found) return err([missing(designId)])

        const { createExporterRegistry, tscircuitExporters, ltspiceExporter } =
          await import("@syntrix/export")
        const registry = createExporterRegistry([...tscircuitExporters, ltspiceExporter])
        const exporter = registry.get(String(fields["format"] ?? ""))

        if (!exporter) {
          return err([
            validationError(
              "EXPORTER_NOT_FOUND",
              `No exporter called "${String(fields["format"])}".`,
              `Available: ${registry
                .list()
                .map((e) => e.id)
                .join(", ")}`,
            ),
          ])
        }

        const result = await exporter.export(found.design, { options: {} })
        if (!result.ok) return result

        // The artifact itself is megabytes and the model cannot act on it. It went to the
        // user through the export route; the model needs to know it worked, not read it.
        return ok({
          summary: `Exported as ${exporter.id}: ${result.value
            .map((a) => `${a.filename} (${a.text?.length ?? a.bytes?.length ?? 0} bytes)`)
            .join(", ")}`,
        })
      }

      default:
        return err([
          validationError(
            "TOOL_NOT_FOUND",
            `"${tool}" is not a tool this backend knows.`,
            "Call one of the tools listed in your tool definitions.",
          ),
        ])
    }
  }

  return {
    submit,
    read,

    async runErc() {
      const found = await store.get(designId)
      if (!found) {
        return {
          pass: false,
          errorCount: 1,
          warningCount: 0,
          summary: `The design ${designId} no longer exists.`,
        }
      }

      const report = runErc(found.design)
      return {
        pass: report.pass,
        errorCount: report.errorCount,
        warningCount: report.warningCount,
        summary: formatErcForLlm(report),
      }
    },
  }
}

/**
 * TSX mode: compile a snippet and merge the result.
 *
 * Invariant 3 of the loop lives here. tscircuit does not throw on a trace selector that
 * matches nothing — it emits a `source_trace_not_connected_error` element and renders the
 * rest (ADR-0017). Merging on a bare `ok` would land a board whose wiring goes nowhere, so
 * the diagnostics are checked and the errors go back to the model *instead of* the merge.
 */
const compileAndMerge = async (
  deps: AgentBackendDeps,
  input: unknown,
): Promise<Result<{ summary: string }, ValidationError[]>> => {
  const fields = (input ?? {}) as Record<string, unknown>
  const code = String(fields["code"] ?? "")
  if (code.length === 0) {
    return err([
      validationError(
        "INVALID_OPERATION",
        "generate_tsx_circuit needs `code`.",
        "Pass a snippet that calls circuit.add(<board>…</board>).",
      ),
    ])
  }

  // Imported here rather than at module load: @syntrix/core/tsx pulls in the whole
  // tscircuit render stack, and a process that never compiles TSX should not pay for it.
  const { compileTsx } = await import("@syntrix/core/tsx")

  const compiled = await compileTsx(code, { name: "agent-tsx" })
  if (!compiled.ok) return compiled

  const errors = compiled.value.diagnostics.filter((d) => d.severity === "error")
  if (errors.length > 0) {
    return err(
      errors.map((diagnostic) =>
        validationError(
          "TSX_COMPILE_FAILED",
          diagnostic.message,
          "Fix the snippet and call generate_tsx_circuit again. A selector that matches " +
            "nothing is the usual cause — check the component names you referenced.",
        ),
      ),
    )
  }

  const strategy = String(fields["strategy"] ?? "merge_by_name")
  const merged = await deps.store.submit(
    deps.designId,
    {
      type: "merge_circuit_json",
      elements: compiled.value.elements,
      strategy: strategy as "merge_by_name" | "append_only" | "replace_all",
    },
    { actor: { kind: "agent", runId: deps.runId } },
  )
  if (!merged.ok) return merged

  const warnings = compiled.value.diagnostics.filter((d) => d.severity !== "error")

  return ok({
    summary:
      `Compiled and merged ${compiled.value.elements.length} elements in ` +
      `${compiled.value.durationMs}ms. The design is at version ${merged.value.record.version}.` +
      (warnings.length > 0
        ? `\n\nWarnings:\n${warnings.map((w) => `- ${w.message}`).join("\n")}`
        : ""),
  })
}

/**
 * Simulate, and return measurements.
 *
 * The netlist comes from the same SPICE exporter the export route uses, so what the model
 * simulates is exactly what a user downloads. The model receives a `SimSummary` — node
 * voltages, a corner frequency, a rise time — and never the raw vectors: a transient run
 * is megabytes of samples, and a context window is not a data store.
 */
const simulate = async (
  deps: AgentBackendDeps,
  fields: Record<string, unknown>,
): Promise<Result<{ summary: string }, ValidationError[]>> => {
  const found = await deps.store.get(deps.designId)
  if (!found) return err([missing(deps.designId)])

  const { createExporterRegistry, tscircuitExporters } = await import("@syntrix/export")
  const { spiceySimulator, summarizeSimResult } = await import("@syntrix/sim")

  const exporter = createExporterRegistry([...tscircuitExporters]).get("spice")
  if (!exporter) {
    return err([
      validationError(
        "EXPORTER_NOT_FOUND",
        "The SPICE exporter is not registered.",
        "This is a bug.",
      ),
    ])
  }

  const netlist = await exporter.export(found.design, { options: {} })
  if (!netlist.ok) return netlist

  const text = netlist.value[0]?.text
  if (!text) {
    return err([
      validationError(
        "SIM_FAILED",
        "The design produced an empty netlist.",
        "Add components and connect them before simulating.",
      ),
    ])
  }

  const kind = String(fields["analysis"] ?? "op")
  const analysis =
    kind === "ac"
      ? {
          kind: "ac" as const,
          sweep: "dec" as const,
          pointsPerDecade: 20,
          startHz: Number(fields["startHz"] ?? 1),
          stopHz: Number(fields["stopHz"] ?? 1_000_000),
        }
      : kind === "tran"
        ? {
            kind: "tran" as const,
            step: String(fields["step"] ?? "1u"),
            stop: String(fields["stop"] ?? "10m"),
          }
        : { kind: "op" as const }

  const result = await spiceySimulator.run(text, analysis)
  if (!result.ok) return result

  const summary = summarizeSimResult(result.value)

  return ok({
    summary: [
      `${summary.analysis} analysis ${summary.ok ? "completed" : "produced no traces"} in ` +
        `${result.value.runtimeMs}ms.`,
      JSON.stringify(summary, undefined, 2),
    ].join("\n\n"),
  })
}

const missing = (id: string): ValidationError =>
  validationError(
    "ELEMENT_NOT_FOUND",
    `No design with id "${id}".`,
    "The design was deleted while the run was in progress.",
  )
