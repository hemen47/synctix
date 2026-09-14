/**
 * The parts API.
 *
 * Search, fetch and pinout, over whatever `PartsIndex` this deployment has — the local
 * one with no database, Mongo, or Meilisearch under the `search` profile. The route does
 * not know which, which is the point of the interface.
 */

import { Router, type Request, type Response } from "express"
import { z } from "zod"
import { LocalPartsIndex, T0_PARTS, resolveFootprint, type PartsIndex } from "@syntrix/parts"
import { toProblemDetails, validationError } from "@syntrix/shared"

const searchQuery = z.object({
  q: z.string().default(""),
  category: z.string().optional(),
  package: z.string().optional(),
  manufacturer: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
})

export const createPartsRouter = (index?: PartsIndex): Router => {
  const router = Router()
  // T0 is always available: the engine has to work with no services running, and a parts
  // palette that is empty until a database is reachable is not a working editor.
  const parts = index ?? new LocalPartsIndex(T0_PARTS)

  router.get("/parts/search", async (req: Request, res: Response) => {
    const query = searchQuery.safeParse(req.query)
    if (!query.success) {
      return res
        .status(400)
        .type("application/problem+json")
        .json(
          toProblemDetails(400, "Invalid query", [
            validationError(
              "INVALID_OPERATION",
              query.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
              "Pass q as a string and limit as a number between 1 and 100.",
            ),
          ]),
        )
    }

    const { q, limit, ...filters } = query.data
    const results = await parts.search(q, {
      ...(filters.category ? { category: filters.category } : {}),
      ...(filters.package ? { package: filters.package } : {}),
      ...(filters.manufacturer ? { manufacturer: filters.manufacturer } : {}),
      limit,
    })

    res.json({ results, index: parts.id })
  })

  router.get("/parts/:id", async (req: Request, res: Response) => {
    const part = await parts.get(req.params["id"]!)
    if (!part) return partNotFound(res, req.params["id"]!)
    res.json(part)
  })

  /**
   * A part's pinout.
   *
   * Separate from the full definition because it is what an agent asks for far more often
   * than anything else, and sending a whole PartDefinition to answer "which pin is VCC"
   * wastes context the model needs for the circuit.
   */
  router.get("/parts/:id/pinout", async (req: Request, res: Response) => {
    const part = await parts.get(req.params["id"]!)
    if (!part) return partNotFound(res, req.params["id"]!)

    res.json({
      id: part.id,
      mpn: part.mpn,
      package: part.footprint.ipc7351Name ?? part.footprint.jedecPackage,
      pins: part.pins.map((pin) => ({
        number: pin.number,
        name: pin.name,
        kind: pin.kind,
        altNames: pin.altNames ?? [],
      })),
    })
  })

  /** Whether a footprint could be resolved, and whether anyone verified it. */
  router.get("/parts/:id/footprint", async (req: Request, res: Response) => {
    const part = await parts.get(req.params["id"]!)
    if (!part) return partNotFound(res, req.params["id"]!)

    const resolved = resolveFootprint(part.footprint)
    res.json(
      resolved.ok
        ? { ...resolved.value, verification: part.footprint.verification }
        : { resolved: false, verification: "unverified", errors: resolved.error },
    )
  })

  return router
}

const partNotFound = (res: Response, id: string): void => {
  res
    .status(404)
    .type("application/problem+json")
    .json(
      toProblemDetails(404, "Part not found", [
        validationError(
          "PART_NOT_FOUND",
          `No part with id "${id}".`,
          "Search at GET /api/parts/search?q=... to find a valid id.",
        ),
      ]),
    )
}
