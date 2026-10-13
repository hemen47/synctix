import { describe, expect, it, vi } from "vitest"
import request from "supertest"
import { rollUp, type DependencyHealth } from "./health"
import { createApp } from "./app"

describe("rollUp", () => {
  it("reports ok when every dependency is up", () => {
    expect(
      rollUp([
        { name: "a", status: "up" },
        { name: "b", status: "up" },
      ]),
    ).toBe("ok")
  })

  it("reports degraded when some dependencies are down", () => {
    expect(
      rollUp([
        { name: "a", status: "up" },
        { name: "b", status: "down" },
      ]),
    ).toBe("degraded")
  })

  it("reports down only when every required dependency is down", () => {
    expect(
      rollUp([
        { name: "a", status: "down" },
        { name: "b", status: "down" },
      ]),
    ).toBe("down")
  })

  it("never reports down for optional dependencies alone", () => {
    // /health decides whether a supervisor restarts the process. Extras going away is
    // not a reason to restart an API that is still serving designs.
    expect(
      rollUp([
        { name: "extra-a", status: "down", optional: true },
        { name: "extra-b", status: "down", optional: true },
      ]),
    ).toBe("degraded")
  })

  it("reports down when the required dependency is down beside a healthy optional one", () => {
    expect(
      rollUp([
        { name: "mongo", status: "down" },
        { name: "extra", status: "up", optional: true },
      ]),
    ).toBe("down")
  })

  it("treats disabled dependencies as not-down", () => {
    // An unconfigured optional source is a deliberate choice, not a fault.
    expect(
      rollUp([
        { name: "a", status: "up" },
        { name: "b", status: "disabled" },
      ]),
    ).toBe("ok")
  })

  it("reports degraded when a required dependency is unknown", () => {
    // Claiming "ok" while knowing nothing about a dependency is worse than admitting it.
    expect(
      rollUp([
        { name: "a", status: "up" },
        { name: "b", status: "unknown" },
      ]),
    ).toBe("degraded")
  })

  it("reports ok for an empty dependency list", () => {
    expect(rollUp([])).toBe("ok")
  })
})

describe("GET /health", () => {
  const probing = (...deps: DependencyHealth[]) => ({
    healthProbes: async (): Promise<DependencyHealth[]> => deps,
  })

  it("returns a report without requiring an API key", async () => {
    const app = createApp({
      version: "0.1.0",
      startedAt: Date.now(),
      apiKey: "secret",
      ...probing({ name: "mongo", status: "up", latencyMs: 2 }),
    })

    const res = await request(app).get("/health").expect(200)

    expect(res.body).toMatchObject({ service: "api", version: "0.1.0", status: "ok" })
    expect(res.body.dependencies).toHaveLength(1)
    expect(res.body.uptimeSec).toBeGreaterThanOrEqual(0)
  })

  it("is also reachable at /api/health, for callers that prefix everything", async () => {
    const app = createApp({
      version: "0.1.0",
      startedAt: Date.now(),
      apiKey: "secret",
      ...probing({ name: "mongo", status: "up" }),
    })

    await request(app).get("/api/health").expect(200)
  })

  it("returns 503 when the database is down, which is what a restart should turn on", async () => {
    const app = createApp({
      version: "0.1.0",
      startedAt: Date.now(),
      ...probing({ name: "mongo", status: "down", detail: "ECONNREFUSED" }),
    })

    const res = await request(app).get("/health")
    expect(res.status).toBe(503)
    expect(res.body.status).toBe("down")
  })

  it("stays 200 and degraded when only an optional dependency is down", async () => {
    // A degraded stack is still serving designs; failing a healthcheck here would restart
    // a working API over something it does not need.
    const app = createApp({
      version: "0.1.0",
      startedAt: Date.now(),
      ...probing(
        { name: "mongo", status: "up" },
        { name: "extra", status: "down", optional: true },
      ),
    })

    const res = await request(app).get("/health").expect(200)
    expect(res.body.status).toBe("degraded")
    expect(
      res.body.dependencies.filter((d: { status: string }) => d.status === "down"),
    ).toHaveLength(1)
  })

  it("reports ok when designs are in memory", async () => {
    // No MONGO_URL is a supported way to run, not a fault: the bootstrap reports the
    // database as `disabled`, and a disabled dependency degrades nothing.
    const app = createApp({
      version: "0.1.0",
      startedAt: Date.now(),
      ...probing({ name: "mongo", status: "disabled", detail: "MONGO_URL is not set" }),
    })

    const res = await request(app).get("/health").expect(200)
    expect(res.body.status).toBe("ok")
  })

  it("reports ok when nothing is probed at all", async () => {
    const app = createApp({ version: "0.1.0", startedAt: Date.now() })

    const res = await request(app).get("/health").expect(200)
    expect(res.body).toMatchObject({ status: "ok", dependencies: [] })
  })
})

describe("GET /live", () => {
  it("does not depend on anything external", async () => {
    // Liveness must never consult a dependency, or a flaky service restarts a healthy
    // process.
    const app = createApp({
      version: "0.1.0",
      startedAt: Date.now(),
      healthProbes: async () => {
        throw new Error("should not be called")
      },
    })

    await request(app).get("/live").expect(200, { status: "ok" })
  })
})

describe("API key auth", () => {
  it("rejects an unauthenticated /api request with problem+json", async () => {
    const app = createApp({ version: "0.1.0", startedAt: Date.now(), apiKey: "secret" })

    const res = await request(app).get("/api/designs").expect(401)

    expect(res.headers["content-type"]).toContain("application/problem+json")
    expect(res.body.errors[0].hint).toContain("x-api-key")
  })

  it("accepts a bearer token as well as the header", async () => {
    const app = createApp({ version: "0.1.0", startedAt: Date.now(), apiKey: "secret" })

    // Auth passes, so this reaches the designs router rather than the 401 handler.
    await request(app).get("/api/designs").set("Authorization", "Bearer secret").expect(200)
    vi.unstubAllGlobals()
  })
})
