/**
 * The designs API: CRUD, operations, history, undo and redo.
 *
 * Thin by design (principle 2). Every route here parses its input, hands it to
 * `@syntrix/core` or the store, and translates the `Result` into HTTP. None of them know
 * what a resistor is.
 *
 * Validation errors come back as problem+json with the engine's own `code`, `message`,
 * `hint` and `elementIds` intact, because the caller is as likely to be an agent as a
 * browser and the hint is what lets it fix its own mistake without another round trip.
 */

import { Router, type Request, type Response } from "express"
import { z } from "zod"
import { operationSchema, runErc, summarizeForLLM } from "@syntrix/core"
import type { Operation } from "@syntrix/core"
import { toProblemDetails, validationError, type ValidationError } from "@syntrix/shared"
import { elkLayoutStrategy } from "@syntrix/layout"
import type { DesignStore } from "./store"

const createBody = z.object({ name: z.string().min(1).max(200).default("Untitled") })

const submitBody = z.object({
  operation: z.unknown(),
  /** Optimistic concurrency. Omitted means "apply regardless", which the UI never does. */
  expectedVersion: z.number().int().nonnegative().optional(),
  actor: z
    .object({
      kind: z.enum(["user", "agent", "import", "system"]).default("user"),
      runId: z.string().optional(),
    })
    .optional(),
})

export const createDesignsRouter = (store: DesignStore): Router => {
  const router = Router()

  router.post("/designs", async (req: Request, res: Response) => {
    const body = createBody.safeParse(req.body ?? {})
    if (!body.success) return badRequest(res, body.error.issues)
    res.status(201).json(await store.create(body.data.name))
  })

  router.get("/designs", async (_req: Request, res: Response) => {
    res.json({ designs: await store.list() })
  })

  router.get("/designs/:id", async (req: Request, res: Response) => {
    const found = await store.get(req.params["id"]!)
    if (!found) return notFound(res, req.params["id"]!)

    res.json({
      ...found.record,
      circuit: found.design.circuit,
      meta: found.design.meta,
      manualEdits: found.design.manualEdits,
    })
  })

  router.delete("/designs/:id", async (req: Request, res: Response) => {
    const removed = await store.delete(req.params["id"]!)
    if (!removed) return notFound(res, req.params["id"]!)
    res.status(204).end()
  })

  /**
   * Apply one operation.
   *
   * The operation is parsed by core's own schema rather than by anything defined here, so
   * the REST surface and the agent's tool surface cannot drift apart: adding an Operation
   * to core adds it to both at once.
   */
  router.post("/designs/:id/operations", async (req: Request, res: Response) => {
    const body = submitBody.safeParse(req.body ?? {})
    if (!body.success) return badRequest(res, body.error.issues)

    const operation = operationSchema.safeParse(body.data.operation)
    if (!operation.success) return badRequest(res, operation.error.issues)

    const result = await store.submit(req.params["id"]!, operation.data as Operation, {
      ...(body.data.expectedVersion !== undefined
        ? { expectedVersion: body.data.expectedVersion }
        : {}),
      ...(body.data.actor ? { actor: body.data.actor } : {}),
    })

    if (!result.ok) return fromValidation(res, result.error)

    res.json({
      ...result.value.record,
      circuit: result.value.design.circuit,
      meta: result.value.design.meta,
      manualEdits: result.value.design.manualEdits,
    })
  })

  router.get("/designs/:id/history", async (req: Request, res: Response) => {
    const found = await store.get(req.params["id"]!)
    if (!found) return notFound(res, req.params["id"]!)
    res.json({ entries: await store.history(req.params["id"]!), version: found.record.version })
  })

  for (const [path, move] of [
    ["undo", (id: string) => store.undo(id)],
    ["redo", (id: string) => store.redo(id)],
  ] as const) {
    router.post(`/designs/:id/${path}`, async (req: Request, res: Response) => {
      const result = await move(req.params["id"]!)
      if (!result.ok) return fromValidation(res, result.error)
      res.json({
        ...result.value.record,
        circuit: result.value.design.circuit,
        meta: result.value.design.meta,
        manualEdits: result.value.design.manualEdits,
      })
    })
  }

  /**
   * Lay the design out.
   *
   * A separate call rather than something every operation triggers: relayout is the
   * expensive part, and a client placing five components wants one layout at the end, not
   * five. Manual placements are untouched — that is the layout engine's contract, not
   * this route's.
   */
  router.post("/designs/:id/layout", async (req: Request, res: Response) => {
    const found = await store.get(req.params["id"]!)
    if (!found) return notFound(res, req.params["id"]!)

    const result = await elkLayoutStrategy.layout(found.design)
    if (!result.ok) return fromValidation(res, result.error)

    res.json({
      elements: result.value.elements,
      bounds: result.value.bounds,
      unsatisfiedConstraints: result.value.unsatisfiedConstraints,
    })
  })

  /**
   * Route the board.
   *
   * Separate from `/layout`, and slower: this runs tscircuit's autorouter, which does real
   * work. The result replaces the design's board layer through a normal operation, so it
   * lands in the log and is undoable like any other change.
   */
  router.post("/designs/:id/route", async (req: Request, res: Response) => {
    const found = await store.get(req.params["id"]!)
    if (!found) return notFound(res, req.params["id"]!)

    // Imported here rather than at module load: @syntrix/core/tsx pulls in the whole
    // tscircuit render stack, and an api that never routes a board should not pay for it.
    const { routePcb, routingFailed } = await import("@syntrix/core/tsx")

    const routed = await routePcb(found.design, req.body?.board ? { board: req.body.board } : {})
    if (!routed.ok) return fromValidation(res, routed.error)

    const merged = await store.submit(
      req.params["id"]!,
      {
        type: "merge_circuit_json",
        elements: routed.value.elements,
        strategy: "append_only",
      },
      { actor: { kind: "system" } },
    )
    if (!merged.ok) return fromValidation(res, merged.error)

    res.json({
      ...merged.value.record,
      traceCount: routed.value.traceCount,
      padCount: routed.value.padCount,
      // tscircuit reports a bad route as an element rather than by failing (ADR-0017), so
      // a caller that only checked the status would ship an unrouted board.
      routingFailed: routingFailed(routed.value),
      diagnostics: routed.value.diagnostics,
    })
  })

  /** Export a design in any registered format. */
  router.post("/designs/:id/export/:format", async (req: Request, res: Response) => {
    const found = await store.get(req.params["id"]!)
    if (!found) return notFound(res, req.params["id"]!)

    const { createExporterRegistry, tscircuitExporters, ltspiceExporter } =
      await import("@syntrix/export")
    const registry = createExporterRegistry([...tscircuitExporters, ltspiceExporter])

    const exporter = registry.get(req.params["format"]!)
    if (!exporter) {
      return res
        .status(404)
        .type("application/problem+json")
        .json(
          toProblemDetails(404, "Unknown export format", [
            validationError(
              "EXPORTER_NOT_FOUND",
              `No exporter called "${req.params["format"]}".`,
              `Available: ${registry
                .list()
                .map((e) => e.id)
                .join(", ")}`,
            ),
          ]),
        )
    }

    const result = await exporter.export(found.design, { options: req.body ?? {} })
    if (!result.ok) return fromValidation(res, result.error)

    res.json({
      format: exporter.id,
      artifacts: result.value.map((artifact) => ({
        filename: artifact.filename,
        mime: artifact.mime,
        text: artifact.text,
        bytes: artifact.bytes ? Buffer.from(artifact.bytes).toString("base64") : undefined,
      })),
    })
  })

  router.get("/designs/:id/erc", async (req: Request, res: Response) => {
    const found = await store.get(req.params["id"]!)
    if (!found) return notFound(res, req.params["id"]!)

    res.json(runErc(found.design))
  })

  /** The design as the agent sees it — a summary, never the raw element array. */
  router.get("/designs/:id/summary", async (req: Request, res: Response) => {
    const found = await store.get(req.params["id"]!)
    if (!found) return notFound(res, req.params["id"]!)
    res.type("text/plain").send(summarizeForLLM(found.design, {}))
  })

  return router
}

/**
 * A zod failure as problem+json.
 *
 * Each issue keeps its path, so a caller is told which field was wrong rather than that
 * "the body was invalid" — the same standard the engine's own errors are held to.
 */
const badRequest = (
  res: Response,
  issues: Array<{ path: Array<string | number>; message: string }>,
): void => {
  res
    .status(400)
    .type("application/problem+json")
    .json(
      toProblemDetails(
        400,
        "Invalid request",
        issues.map((issue) =>
          validationError(
            "INVALID_OPERATION",
            `${issue.path.join(".") || "(body)"}: ${issue.message}`,
            "Check the request shape against the API documentation, or POST a valid Operation.",
          ),
        ),
      ),
    )
}

const notFound = (res: Response, id: string): void => {
  res
    .status(404)
    .type("application/problem+json")
    .json(
      toProblemDetails(404, "Design not found", [
        validationError(
          "ELEMENT_NOT_FOUND",
          `No design with id "${id}".`,
          "List designs at GET /api/designs to find a valid id.",
        ),
      ]),
    )
}

/**
 * Validation errors as HTTP.
 *
 * A version conflict is 409 and everything else is 422: the distinction matters to a
 * client, because a conflict is worth retrying after a re-read and a validation failure
 * never is.
 */
const fromValidation = (res: Response, errors: ValidationError[]): void => {
  const conflict = errors.some((e) => e.code === "VERSION_CONFLICT")
  const missing = errors.some((e) => e.code === "ELEMENT_NOT_FOUND" && /No design/.test(e.message))
  const status = conflict ? 409 : missing ? 404 : 422

  res
    .status(status)
    .type("application/problem+json")
    .json(
      toProblemDetails(
        status,
        conflict ? "Version conflict" : missing ? "Design not found" : "Operation rejected",
        errors,
      ),
    )
}
