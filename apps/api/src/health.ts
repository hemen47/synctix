/**
 * Aggregated health.
 *
 * M0''s exit criterion is that the stack reports health, so this endpoint probes every
 * dependency and reports per-dependency status rather than a bare 200. A stack where one
 * container is wedged should say which one.
 *
 * v2 has only four required services, and the api's own HTTP dependencies are both
 * optional compose profiles: an unconfigured URL means that profile is not running, which
 * is a deliberate choice ("disabled"), not a fault.
 */

import type { Request, Response } from "express"

export type DependencyStatus = "up" | "down" | "disabled" | "unknown"

export interface DependencyHealth {
  name: string
  status: DependencyStatus
  latencyMs?: number
  detail?: string
}

export interface HealthReport {
  status: "ok" | "degraded" | "down"
  service: string
  version: string
  uptimeSec: number
  checkedAt: string
  dependencies: DependencyHealth[]
}

interface ProbeSpec {
  name: string
  url: string | undefined
  /** Optional dependencies report "disabled" instead of "down" when unconfigured. */
  optional?: boolean
}

const PROBE_TIMEOUT_MS = 3000

/**
 * Probe one HTTP dependency. Never throws: a health endpoint that fails when a
 * dependency is unreachable tells you nothing you could not already see.
 */
export const probeHttp = async (spec: ProbeSpec): Promise<DependencyHealth> => {
  if (!spec.url) {
    return {
      name: spec.name,
      status: spec.optional ? "disabled" : "unknown",
      detail: "no URL configured",
    }
  }

  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)

  try {
    const res = await fetch(spec.url, { signal: controller.signal })
    const latencyMs = Date.now() - started
    return res.ok
      ? { name: spec.name, status: "up", latencyMs }
      : { name: spec.name, status: "down", latencyMs, detail: `HTTP ${res.status}` }
  } catch (cause) {
    const detail =
      cause instanceof Error && cause.name === "AbortError"
        ? `timed out after ${PROBE_TIMEOUT_MS}ms`
        : cause instanceof Error
          ? cause.message
          : "unreachable"
    return { name: spec.name, status: "down", latencyMs: Date.now() - started, detail }
  } finally {
    clearTimeout(timer)
  }
}

export const buildProbeSpecs = (env: NodeJS.ProcessEnv): ProbeSpec[] => [
  // Profile `kicad` — kicad-cli ERC/DRC/export.
  { name: "kicad", url: joinUrl(env.KICAD_SERVICE_URL, "/health"), optional: true },
  // Profile `search` — Meilisearch behind the same PartsIndex interface as Mongo's
  // text index, which is what runs when this is absent.
  { name: "meilisearch", url: joinUrl(env.MEILI_URL, "/health"), optional: true },
]

const joinUrl = (base: string | undefined, path: string): string | undefined =>
  base ? `${base.replace(/\/+$/, "")}${path}` : undefined

/**
 * Roll per-dependency results into one status.
 *
 * A single down dependency is *degraded*, not down — the API still serves designs when
 * KiCad export is unavailable. Only a stack with nothing reachable is down.
 *
 * `unknown` also counts as degraded. A required dependency with no URL configured means
 * we cannot vouch for it, and a health endpoint that answers "ok" while knowing nothing
 * about its dependencies is worse than one that admits the gap. `disabled` is different:
 * it is a deliberate choice, so it does not degrade anything.
 */
export const rollUp = (deps: DependencyHealth[]): HealthReport["status"] => {
  const relevant = deps.filter((d) => d.status !== "disabled")
  const downs = relevant.filter((d) => d.status === "down")

  if (relevant.length > 0 && downs.length === relevant.length) return "down"
  if (downs.length > 0) return "degraded"
  return relevant.some((d) => d.status === "unknown") ? "degraded" : "ok"
}

export const createHealthHandler = (opts: {
  service: string
  version: string
  startedAt: number
  env?: NodeJS.ProcessEnv
  /** Extra probes (Mongo, and Redis under the `indexing` profile) injected once wired. */
  extraProbes?: () => Promise<DependencyHealth[]>
}) => {
  return async (_req: Request, res: Response): Promise<void> => {
    const env = opts.env ?? process.env
    const [httpDeps, extras] = await Promise.all([
      Promise.all(buildProbeSpecs(env).map(probeHttp)),
      opts.extraProbes?.() ?? Promise.resolve([]),
    ])

    const dependencies = [...httpDeps, ...extras]
    const status = rollUp(dependencies)

    const report: HealthReport = {
      status,
      service: opts.service,
      version: opts.version,
      uptimeSec: Math.round((Date.now() - opts.startedAt) / 1000),
      checkedAt: new Date().toISOString(),
      dependencies,
    }

    // "degraded" is still a live service, so it must not fail a container healthcheck;
    // only a fully down stack returns 503.
    res.status(status === "down" ? 503 : 200).json(report)
  }
}

/**
 * Liveness, as distinct from readiness above. Container healthchecks hit this: it must
 * not depend on anything external, or a flaky dependency restarts a healthy process.
 */
export const livenessHandler = (_req: Request, res: Response): void => {
  res.status(200).json({ status: "ok" })
}
