/**
 * The parts API.
 *
 * Search, fetch and pinout, over whatever `PartsIndex` this deployment has — the local
 * one with no database, or Mongo where one is configured. The route does
 * not know which, which is the point of the interface.
 */

import { Router, type Request, type Response } from "express"
import { z } from "zod"
import {
  LocalPartsIndex,
  T0_PARTS,
  USER_PART_PREFIX,
  buildUserPart,
  pinKindSchema,
  resolveFootprint,
  type PartsIndex,
} from "@syntrix/parts"
import { toProblemDetails, validationError } from "@syntrix/shared"

const searchQuery = z.object({
  q: z.string().default(""),
  category: z.string().optional(),
  package: z.string().optional(),
  manufacturer: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
})

/**
 * What a person can reasonably type about a part.
 *
 * Far narrower than `PartDefinition`, which also carries provenance, licensing, lifecycle
 * and distributor blocks. Those are filled in by `buildUserPart` — honestly, which is why
 * the footprint comes back `unverified` however confident the user is.
 */
const userPartInput = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  category: z.string().max(60).optional(),
  ftype: z.string().max(60).optional(),
  footprinterString: z.string().max(120).optional(),
  datasheetUrl: z.string().max(500).optional(),
  pins: z
    .array(
      z.object({
        number: z.union([z.number().int().positive(), z.string().min(1)]),
        name: z.string().min(1).max(60),
        kind: pinKindSchema.optional(),
        altNames: z.array(z.string()).optional(),
      }),
    )
    .max(512),
})

export const createPartsRouter = (index?: PartsIndex): Router => {
  const router = Router()
  // T0 is always available: the engine has to work with no services running, and a parts
  // palette that is empty until a database is reachable is not a working editor.
  const parts = index ?? new LocalPartsIndex(T0_PARTS)

  /**
   * Whether this deployment can store a part the user defines.
   *
   * Everything implements `upsert`, but on a bare `LocalPartsIndex` the write lands in
   * memory and is gone at the next restart. Offering a form that silently forgets is
   * worse than not offering one, so the capability is reported and the route refuses.
   */
  const writable = parts.id !== "local"

  router.get("/parts/capabilities", (_req: Request, res: Response) => {
    res.json({ canAddParts: writable, index: parts.id, prefix: USER_PART_PREFIX })
  })

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

  /**
   * Define a part of your own.
   *
   * Validation happens in `@syntrix/parts`, not here, and the failures come back as the
   * engine's own `ValidationError`s — so the form shows "the footprint has 2 pads but the
   * part has 4 pins" rather than "invalid part". A custom part with a wrong footprint is
   * a board that does not fit, so this route refuses rather than storing and warning.
   */
  router.post("/parts", async (req: Request, res: Response) => {
    if (!writable) return readOnly(res)

    const body = userPartInput.safeParse(req.body ?? {})
    if (!body.success) {
      return res
        .status(400)
        .type("application/problem+json")
        .json(
          toProblemDetails(
            400,
            "Invalid part",
            body.error.issues.map((issue) =>
              validationError(
                "INVALID_PROP",
                `${issue.path.join(".") || "(part)"}: ${issue.message}`,
                "Send { name, pins: [{ number, name, kind? }], footprinterString?, … }.",
              ),
            ),
          ),
        )
    }

    const built = buildUserPart(body.data)
    if (!built.ok) {
      return res
        .status(422)
        .type("application/problem+json")
        .json(toProblemDetails(422, "The part could not be saved", built.error))
    }

    await parts.upsert([built.value])
    res.status(201).json(built.value)
  })

  /** Delete one of your own parts. Built-in parts are not deletable. */
  router.delete("/parts/:id", async (req: Request, res: Response) => {
    const id = req.params["id"]!
    if (!writable) return readOnly(res)

    if (!id.startsWith(USER_PART_PREFIX)) {
      return res
        .status(403)
        .type("application/problem+json")
        .json(
          toProblemDetails(403, "Not your part", [
            validationError(
              "INVALID_OPERATION",
              `"${id}" is a built-in part.`,
              "Only parts you defined yourself can be deleted. They are the ones whose id " +
                `starts with "${USER_PART_PREFIX}".`,
            ),
          ]),
        )
    }

    const { removed } = await parts.remove([id])
    if (removed === 0) return partNotFound(res, id)
    res.status(204).end()
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

const readOnly = (res: Response): void => {
  res
    .status(501)
    .type("application/problem+json")
    .json(
      toProblemDetails(501, "Custom parts are not enabled", [
        validationError(
          "PART_SOURCE_DISABLED",
          "This deployment has no writable parts library.",
          "Custom parts are stored in data/parts/user-parts.json. Start the API with that " +
            "store enabled — it is the default — and try again.",
        ),
      ]),
    )
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
