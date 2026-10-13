/**
 * Express app factory. Kept separate from the server bootstrap so tests can mount it
 * with supertest without binding a port.
 */

import { existsSync } from "node:fs"
import { join } from "node:path"
import express, { type Express, type NextFunction, type Request, type Response } from "express"
import cors from "cors"
import { toProblemDetails, validationError } from "@syntrix/shared"
import { createPartsStack, type PartsStack } from "./parts-stack"
import { createHealthHandler, livenessHandler, type DependencyHealth } from "./health"
import { createDesignsRouter } from "./designs"
import { createPartsRouter } from "./parts"
import { createAgentRouter } from "./agent-routes"
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
  /**
   * Reports the health of whatever this process depends on — in practice MongoDB, from
   * the bootstrap that owns the connection. Overridable so tests can drive it.
   */
  healthProbes?: () => Promise<DependencyHealth[]>
  /**
   * Where designs live. Defaults to the in-memory store, which is what a development
   * stack with no MONGO_URL runs on — not a test double.
   */
  store?: DesignStore
  /**
   * Directory of the built web app. When set, this process serves the SPA on the same
   * port as the API — which is what production runs (ADR-0029). Unset in development,
   * where Vite serves the app and proxies here.
   */
  webDist?: string
  /**
   * Where `config/models.yaml` lives. Defaults to the one in the repo, found by walking
   * up for the workspace marker rather than by trusting the working directory — the api
   * is started from `apps/api` in development and from `dist` in production.
   */
  modelsConfigPath?: string
  /**
   * Where the user's own parts are stored. Defaults to `data/parts/user-parts.json`.
   * A test points this at a scratch directory so a run never touches a real library.
   */
  userPartsPath?: string
  /**
   * The process-wide parts stack. Passed in by the server bootstrap, which needs the
   * resolver before it can build a store; created here when a test does not supply one.
   */
  partsStack?: PartsStack
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
    ...(opts.healthProbes ? { extraProbes: opts.healthProbes } : {}),
  })
  app.get("/health", health)
  app.get("/api/health", health)
  app.get("/live", livenessHandler)

  if (opts.apiKey) app.use("/api", requireApiKey(opts.apiKey))

  /**
   * One parts stack for the whole process — the palette, the agent, MCP and the engine's
   * own `partRef` resolution all come from here, so a part the user defines is usable
   * everywhere the moment it is saved.
   */
  const { parts, resolvePart } = opts.partsStack ?? createPartsStack(opts.userPartsPath)

  // Every feature router is mounted under /api, behind the api-key check above.
  const store = opts.store ?? new MemoryDesignStore({ resolvePart })
  app.use("/api", createDesignsRouter(store))
  app.use("/api", createPartsRouter(parts))
  app.use(
    "/api",
    createAgentRouter({
      store,
      parts,
      ...(opts.modelsConfigPath ? { modelsConfigPath: opts.modelsConfigPath } : {}),
    }),
  )

  // MCP is mounted outside /api: it has its own transport, its own auth and its own path
  // (v2 principle 10 — one process, not one prefix).
  app.use(
    createMcpRouter({
      store,
      parts,
      ...(opts.mcpBearerToken ? { bearerToken: opts.mcpBearerToken } : {}),
      version: opts.version,
    }),
  )

  if (opts.webDist) mountWebApp(app, opts.webDist)

  app.use(notFoundHandler)
  app.use(errorHandler)

  return app
}

/**
 * Serve the built SPA from the API process, so a deployment is one process on one port
 * with no reverse proxy in front of it (ADR-0029).
 *
 * Mounted last, after every router: the API owns its prefixes, and everything else is
 * the app. Without that ordering the SPA fallback would swallow a mistyped /api path and
 * answer it with index.html, turning a 404 into a parse error in the client.
 */
const mountWebApp = (app: Express, dist: string): void => {
  if (!existsSync(dist)) {
    console.warn(`[api] web dist not found at ${dist} — serving the API only. Run pnpm build.`)
    return
  }

  const index = join(dist, "index.html")

  // Vite fingerprints everything under /assets, so those are immutable. index.html must
  // never be cached, or a deploy strands clients on a bundle whose chunks are gone.
  app.use(
    express.static(dist, {
      index: false,
      setHeaders: (res, path) => {
        res.setHeader(
          "Cache-Control",
          path.endsWith(".html") ? "no-cache" : "public, max-age=31536000, immutable",
        )
      },
    }),
  )

  app.use((req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== "GET" && req.method !== "HEAD") return next()
    if (/^\/(api|mcp)(\/|$)/.test(req.path) || req.path === "/health" || req.path === "/live") {
      return next()
    }
    res.sendFile(index)
  })
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
