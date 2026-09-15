/**
 * Express app factory. Kept separate from the server bootstrap so tests can mount it
 * with supertest without binding a port.
 */

import express, { type Express, type NextFunction, type Request, type Response } from "express"
import cors from "cors"
import { toProblemDetails, validationError } from "@syntrix/shared"
import { t0Resolver } from "@syntrix/parts"
import { createHealthHandler, livenessHandler } from "./health"
import { createDesignsRouter } from "./designs"
import { createPartsRouter } from "./parts"
import { createMcpRouter } from "./mcp-routes"
import { MemoryDesignStore, type DesignStore } from "./store"

export interface AppOptions {
  version: string
  startedAt: number
  /** Requests must carry this in `x-api-key`. Auth is skipped when unset (dev only). */
  apiKey?: string
  /**
   * Bearer token for `/mcp`. Separate from the REST key on purpose: an MCP client is a
   * different kind of caller with a different lifetime, and revoking one should not log
   * out the other.
   */
  mcpBearerToken?: string
  publicOrigin?: string
  /** Overridable so tests can drive the dependency probes deterministically. */
  env?: NodeJS.ProcessEnv
  /**
   * Where designs live. Defaults to the in-memory store, which is what a development
   * stack with no MONGO_URL runs on — not a test double.
   */
  store?: DesignStore
}

export const createApp = (opts: AppOptions): Express => {
  const app = express()

  app.disable("x-powered-by")
  app.use(express.json({ limit: "16mb" })) // circuit-json payloads get large
  app.use(
    cors({
      origin: opts.publicOrigin ?? true,
      credentials: true,
      allowedHeaders: ["Content-Type", "x-api-key", "Authorization"],
    }),
  )

  // Health is mounted before auth: an operator must be able to see the stack's status
  // without holding an API key.
  const health = createHealthHandler({
    service: "api",
    version: opts.version,
    startedAt: opts.startedAt,
    env: opts.env,
  })
  app.get("/health", health)
  app.get("/api/health", health)
  app.get("/live", livenessHandler)

  if (opts.apiKey) app.use("/api", requireApiKey(opts.apiKey))

  // Every feature router is mounted under /api, behind the api-key check above.
  const store = opts.store ?? new MemoryDesignStore({ resolvePart: t0Resolver })
  app.use("/api", createDesignsRouter(store))
  app.use("/api", createPartsRouter())

  // MCP is mounted outside /api: it has its own transport, its own auth and its own path,
  // which is also what Caddy routes on (v2 principle 10 — one process, not one prefix).
  app.use(
    createMcpRouter({
      store,
      ...(opts.mcpBearerToken ? { bearerToken: opts.mcpBearerToken } : {}),
      version: opts.version,
    }),
  )

  app.use(notFoundHandler)
  app.use(errorHandler)

  return app
}

/** Single-tenant v1. The header name stays the same when real users arrive. */
const requireApiKey =
  (expected: string) =>
  (req: Request, res: Response, next: NextFunction): void => {
    if (req.path === "/health") return next()

    const provided = req.header("x-api-key") ?? bearerToken(req.header("authorization"))
    if (provided !== expected) {
      res
        .status(401)
        .type("application/problem+json")
        .json(
          toProblemDetails(401, "Unauthorized", [
            validationError(
              "PROVIDER_ERROR",
              "Missing or invalid API key.",
              "Send the key in an 'x-api-key' header, or as 'Authorization: Bearer <key>'.",
            ),
          ]),
        )
      return
    }
    next()
  }

const bearerToken = (header: string | undefined): string | undefined =>
  header?.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : undefined

const notFoundHandler = (req: Request, res: Response): void => {
  res
    .status(404)
    .type("application/problem+json")
    .json(
      toProblemDetails(
        404,
        "Not Found",
        [
          validationError(
            "ELEMENT_NOT_FOUND",
            `No route for ${req.method} ${req.path}.`,
            "Check the path against the OpenAPI document at /api/openapi.json.",
          ),
        ],
        req.path,
      ),
    )
}

/**
 * Terminal error handler. Domain failures never reach here — they come back as
 * `Result` and are turned into problem+json by their route. Anything arriving here is a
 * bug, so it is logged loudly and reported without leaking internals.
 */
const errorHandler = (error: unknown, req: Request, res: Response, _next: NextFunction): void => {
  const message = error instanceof Error ? error.message : String(error)
  // Replaced by pino in the server bootstrap.
  console.error("[api] unhandled error", { path: req.path, error })

  res
    .status(500)
    .type("application/problem+json")
    .json(
      toProblemDetails(
        500,
        "Internal Server Error",
        [
          validationError(
            "PROVIDER_ERROR",
            "An unexpected error occurred.",
            "This is a bug in SYNTRIX. Retry; if it persists, report it with the instance path.",
            [],
            { message },
          ),
        ],
        req.path,
      ),
    )
}
