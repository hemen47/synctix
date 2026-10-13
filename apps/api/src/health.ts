/**
 * Aggregated health.
 *
 * The exit criterion is that the stack reports health, so this endpoint names each
 * dependency and its state rather than answering a bare 200. A stack that is wedged
 * should say what is wedged.
 *
 * There is exactly one dependency left to report on: MongoDB. The api has no HTTP
 * dependencies at all now that the `kicad` and `search` containers are gone and their
 * work happens in-process (ADR-0029), so `probeHttp` and its profile specs went with
 * them. Probes arrive through `extraProbes` instead, from whoever owns the connection.
 */

import type { Request, Response } from "express"

export type DependencyStatus = "up" | "down" | "disabled" | "unknown"

export interface DependencyHealth {
  name: string
  status: DependencyStatus
  latencyMs?: number
  detail?: string
  /**
   * An optional dependency can degrade the report but never take the stack down. Without
   * this distinction a deliberately-absent extra reads the same as a database we cannot
   * reach (ADR-0027).
   */
  optional?: boolean
}

export interface HealthReport {
  status: "ok" | "degraded" | "down"
  service: string
  version: string
  uptimeSec: number
  checkedAt: string
  dependencies: DependencyHealth[]
}

/**
 * Roll per-dependency results into one status.
 *
 * A single down dependency is *degraded*, not down. Only a stack whose *required*
 * dependencies are all unreachable is down, because only then can we not serve at all.
 *
 * An optional dependency never takes the stack down, however many are wedged. This
 * endpoint decides whether a supervisor restarts the process, and restarting a working
 * API because an extra went away is the failure the 503/degraded split exists to prevent.
 *
 * `unknown` also counts as degraded. A required dependency we cannot vouch for is worse
 * than one we know is broken, and answering "ok" while knowing nothing is worse than
 * either. `disabled` is different: it is a deliberate choice, so it degrades nothing.
 */
export const rollUp = (deps: DependencyHealth[]): HealthReport["status"] => {
  const relevant = deps.filter((d) => d.status !== "disabled")
  const required = relevant.filter((d) => !d.optional)

  if (required.length > 0 && required.every((d) => d.status === "down")) return "down"
  if (relevant.some((d) => d.status === "down")) return "degraded"
  return relevant.some((d) => d.status === "unknown") ? "degraded" : "ok"
}

export const createHealthHandler = (opts: {
  service: string
  version: string
  startedAt: number
  /** Supplied by the bootstrap, which is what holds the database connection. */
  extraProbes?: () => Promise<DependencyHealth[]>
}) => {
  return async (_req: Request, res: Response): Promise<void> => {
    const dependencies = (await opts.extraProbes?.()) ?? []
    const status = rollUp(dependencies)

    const report: HealthReport = {
      status,
      service: opts.service,
      version: opts.version,
      uptimeSec: Math.round((Date.now() - opts.startedAt) / 1000),
      checkedAt: new Date().toISOString(),
      dependencies,
    }

    // "degraded" is still a live service, so it must not fail a supervisor's healthcheck;
    // only a fully down stack returns 503.
    res.status(status === "down" ? 503 : 200).json(report)
  }
}

/**
 * Liveness, as distinct from readiness above. A supervisor's restart check hits this: it
 * must not depend on anything external, or a flaky dependency restarts a healthy process.
 */
export const livenessHandler = (_req: Request, res: Response): void => {
  res.status(200).json({ status: "ok" })
}
