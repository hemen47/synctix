/**
 * MCP over Streamable HTTP, mounted at `/mcp` in the api process.
 *
 * Streamable HTTP is stateful per session: a client POSTs an `initialize`, gets an
 * `mcp-session-id` header back, and sends everything afterwards with that header. The
 * transports are therefore kept in a map rather than created per request, and each gets
 * its own `McpServer` — sharing one across sessions would leak state between clients.
 *
 * Auth is a bearer token, checked before the transport sees anything. It is separate from
 * the REST API key on purpose: an MCP client is a different kind of caller with a
 * different lifetime, and revoking one should not log out the other.
 */

import { randomUUID } from "node:crypto"
import { Router, type Request, type Response } from "express"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { toProblemDetails, validationError } from "@syntrix/shared"
import { createMcpServer, type McpDeps } from "./mcp"

export interface McpRouteOptions extends McpDeps {
  /** Requests must carry `Authorization: Bearer <token>`. Unset disables the check. */
  bearerToken?: string
}

export const createMcpRouter = (options: McpRouteOptions): Router => {
  const router = Router()
  const transports = new Map<string, StreamableHTTPServerTransport>()

  const authorised = (req: Request, res: Response): boolean => {
    if (!options.bearerToken) return true

    const header = req.get("authorization") ?? ""
    const token = header.startsWith("Bearer ") ? header.slice(7) : undefined
    if (token === options.bearerToken) return true

    res
      .status(401)
      .type("application/problem+json")
      .json(
        toProblemDetails(401, "Unauthorized", [
          validationError(
            "TOOL_NOT_FOUND",
            "The MCP endpoint requires a bearer token.",
            "Send Authorization: Bearer <MCP_BEARER_TOKEN>.",
          ),
        ]),
      )
    return false
  }

  /**
   * Every MCP message arrives here.
   *
   * A request carrying a known session id continues that session; an `initialize` without
   * one starts a new session and a new server. Anything else is a client that has lost
   * its session, which is worth saying explicitly rather than failing obscurely.
   */
  router.post("/mcp", async (req: Request, res: Response) => {
    if (!authorised(req, res)) return

    const sessionId = req.get("mcp-session-id")
    const existing = sessionId ? transports.get(sessionId) : undefined

    if (existing) {
      await existing.handleRequest(req, res, req.body)
      return
    }

    if (!isInitialize(req.body)) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message:
            "No MCP session. Send an initialize request first, then include the " +
            "mcp-session-id header it returns.",
        },
        id: null,
      })
      return
    }

    // Declared before construction: the callback closes over it, and TypeScript cannot
    // infer the type of a value referenced inside its own initialiser.
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id: string): void => {
        transports.set(id, transport)
      },
    })

    // Drop the transport when the client goes away, or the map grows for the life of the
    // process — a long-lived server with a chatty client is exactly where that shows up.
    transport.onclose = () => {
      if (transport.sessionId) transports.delete(transport.sessionId)
    }

    const server = createMcpServer(options)
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  })

  /** The server→client stream, and session teardown. Both keyed by the session header. */
  for (const method of ["get", "delete"] as const) {
    router[method]("/mcp", async (req: Request, res: Response) => {
      if (!authorised(req, res)) return

      const sessionId = req.get("mcp-session-id")
      const transport = sessionId ? transports.get(sessionId) : undefined
      if (!transport) {
        res.status(404).json({
          jsonrpc: "2.0",
          error: { code: -32001, message: "Unknown MCP session." },
          id: null,
        })
        return
      }

      await transport.handleRequest(req, res)
    })
  }

  return router
}

const isInitialize = (body: unknown): boolean =>
  typeof body === "object" && body !== null && (body as { method?: string }).method === "initialize"
