/**
 * The agent over HTTP: one streaming run, and a status probe.
 *
 * **Why SSE and not a plain POST.** A run is a dozen provider round trips and as many
 * engine calls; it takes tens of seconds. A request that returns only at the end gives the
 * user a spinner and no idea whether the thing is working, thinking or stuck — and when it
 * fails on the ninth tool call, no idea what the first eight did. The trace is the
 * product: the user watches the agent search for a part, look up its pinout, wire it, and
 * run ERC, and can tell a wrong answer from a wrong *approach*. Server-sent events are the
 * smallest thing that does this — one direction, plain HTTP, no socket to keep alive.
 *
 * **Why `GET /agent/status` exists.** The commonest failure of this feature is not a bad
 * design, it is no API key. Asking before the run means the UI can say "set
 * OPENROUTER_API_KEY in .env" next to a disabled input, instead of letting someone type a
 * paragraph and then telling them.
 */

import { Router, type Request, type Response } from "express"
import { z } from "zod"
import {
  allTools,
  buildSystemPrompt,
  createModelClient,
  loadModelsConfig,
  modelsConfigPath,
  loadTscircuitSkill,
  providerStatus,
  resolveRouting,
  runAgent,
  type AgentTraceEvent,
  type ModelsConfig,
} from "@syntrix/agent"
import { summarizeForLLM } from "@syntrix/core"
import { LocalPartsIndex, T0_PARTS, type PartsIndex } from "@syntrix/parts"
import { newId, toProblemDetails, validationError } from "@syntrix/shared"
import { createAgentBackend } from "./agent-backend"
import type { DesignStore } from "./store"

const runBody = z.object({
  prompt: z.string().min(1).max(8000),
  /**
   * Which role's model runs the loop. `executor` by default — it is the one tuned for
   * tool volume, and it is where the cost of a run actually lands.
   */
  role: z.enum(["planner", "executor", "reviewer"]).default("executor"),
})

export interface AgentRouterDeps {
  store: DesignStore
  parts?: PartsIndex
  /** Overridable so a test can point at a fixture instead of the repo's config. */
  modelsConfigPath?: string
}

/**
 * Load `models.yaml` once, lazily.
 *
 * Read on first use rather than at module load so that an api process with no agent
 * configured still starts, and so a test that never touches the agent never needs the
 * file to exist. Cached after the first read, including the failure.
 */
const configLoader = (path: string) => {
  let cached: { config?: ModelsConfig; error?: string } | undefined

  return (): { config?: ModelsConfig; error?: string } => {
    if (!cached) {
      try {
        cached = { config: loadModelsConfig(path) }
      } catch (cause) {
        cached = { error: cause instanceof Error ? cause.message : String(cause) }
      }
    }
    return cached
  }
}

export const createAgentRouter = (deps: AgentRouterDeps): Router => {
  const router = Router()
  const parts = deps.parts ?? new LocalPartsIndex(T0_PARTS)
  const loadConfig = configLoader(deps.modelsConfigPath ?? modelsConfigPath())

  /**
   * Can the agent run at all, and with what?
   *
   * Reports per role rather than a single boolean: a deployment can perfectly well have a
   * key for the executor's provider and not the planner's, and "the agent is unavailable"
   * would be both true and useless.
   */
  router.get("/agent/status", (_req: Request, res: Response) => {
    const { config, error } = loadConfig()
    if (!config) {
      return res.json({
        available: false,
        detail: `config/models.yaml could not be read: ${error}`,
        roles: [],
      })
    }

    const roles = (["planner", "executor", "reviewer"] as const).map((role) => {
      try {
        const routing = resolveRouting(config, role)
        const status = providerStatus(config, routing.provider)
        return {
          role,
          provider: routing.provider,
          model: routing.model,
          available: status.available,
          ...(status.detail ? { detail: status.detail } : {}),
        }
      } catch (cause) {
        return {
          role,
          available: false,
          detail: cause instanceof Error ? cause.message : String(cause),
        }
      }
    })

    res.json({
      available: roles.some((role) => role.available),
      roles,
      limits: config.limits,
    })
  })

  /**
   * Run the agent against a design, streaming the trace.
   *
   * Every event the loop emits goes out as it happens, then one terminal `done` or
   * `error`. The client redraws the design from its own `GET /designs/:id` when the run
   * finishes rather than receiving it here: the design is already an addressable resource
   * and duplicating it into the stream would give two paths to the same state that could
   * disagree.
   */
  router.post("/designs/:id/agent", async (req: Request, res: Response) => {
    const designId = req.params["id"]!

    const body = runBody.safeParse(req.body ?? {})
    if (!body.success) {
      return res
        .status(400)
        .type("application/problem+json")
        .json(
          toProblemDetails(
            400,
            "Invalid request",
            body.error.issues.map((issue) =>
              validationError(
                "INVALID_OPERATION",
                `${issue.path.join(".") || "(body)"}: ${issue.message}`,
                "Send { prompt: string, role?: 'planner' | 'executor' | 'reviewer' }.",
              ),
            ),
          ),
        )
    }

    const found = await deps.store.get(designId)
    if (!found) {
      return res
        .status(404)
        .type("application/problem+json")
        .json(
          toProblemDetails(404, "Design not found", [
            validationError(
              "ELEMENT_NOT_FOUND",
              `No design with id "${designId}".`,
              "List designs at GET /api/designs.",
            ),
          ]),
        )
    }

    const { config, error: configError } = loadConfig()
    if (!config) {
      return res
        .status(503)
        .type("application/problem+json")
        .json(
          toProblemDetails(503, "Agent unavailable", [
            validationError(
              "PROVIDER_ERROR",
              `config/models.yaml could not be read: ${configError}`,
              "Check that config/models.yaml exists and is well formed.",
            ),
          ]),
        )
    }

    // Availability is checked here, before a single byte of the stream is written. Once
    // the response is an event stream the status code is already 200, and "no API key"
    // would arrive as an error event inside a successful response — technically fine, and
    // much harder for a client to handle than a 503.
    let model
    try {
      model = await createModelClient(config, body.data.role)
    } catch (cause) {
      return res
        .status(503)
        .type("application/problem+json")
        .json(
          toProblemDetails(503, "Agent unavailable", [
            validationError(
              "PROVIDER_ERROR",
              cause instanceof Error ? cause.message : String(cause),
              "Set the provider's API key in .env, or point the role at another provider " +
                "in config/models.yaml.",
            ),
          ]),
        )
    }

    res.status(200).set({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Without this a reverse proxy may buffer the whole stream and deliver it at the
      // end, which turns a live trace back into the spinner this route exists to avoid.
      "X-Accel-Buffering": "no",
    })
    res.flushHeaders?.()

    const send = (event: string, data: unknown): void => {
      if (res.writableEnded) return
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    const runId = newId("run")
    send("start", { runId, designId, model: model.id, role: body.data.role })

    // A client that navigates away must not leave the loop running against a dead socket.
    let aborted = false
    req.on("close", () => {
      aborted = true
    })

    const backend = createAgentBackend({ store: deps.store, designId, parts, runId })

    const system = buildSystemPrompt({
      skill: loadTscircuitSkill(),
      designSummary: summarizeForLLM(found.design, {}),
    })

    try {
      const result = await runAgent(model, backend, {
        system,
        prompt: body.data.prompt,
        tools: allTools(),
        limits: config.limits,
        emit: (event: AgentTraceEvent) => {
          if (!aborted) send("trace", event)
        },
      })

      if (!result.ok) {
        send("error", { errors: result.error })
      } else {
        send("done", {
          runId,
          text: result.value.text,
          iterations: result.value.iterations,
          toolCalls: result.value.toolCalls,
          erc: result.value.erc,
          stopReason: result.value.stopReason,
          usage: result.value.usage,
        })
      }
    } catch (cause) {
      // An exception here is a bug or a provider failure the SDK did not translate.
      // Either way the client is mid-stream and needs to be told, not left hanging.
      send("error", {
        errors: [
          validationError(
            "PROVIDER_ERROR",
            cause instanceof Error ? cause.message : String(cause),
            "The run stopped. Any operations already applied are in the design and the log.",
          ),
        ],
      })
    } finally {
      res.end()
    }
  })

  return router
}
