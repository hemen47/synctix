import { describe, expect, it, vi, afterEach } from "vitest"
import request from "supertest"
import { buildProbeSpecs, probeHttp, rollUp } from "./health"
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

  it("reports down only when every dependency is down", () => {
    expect(
      rollUp([
        { name: "a", status: "down" },
        { name: "b", status: "down" },
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

  it("does not report down when the only non-disabled dependency is up", () => {
    expect(
      rollUp([
        { name: "a", status: "up" },
        { name: "b", status: "disabled" },
      ]),
    ).toBe("ok")
  })

  it("reports ok for an empty dependency list", () => {
    expect(rollUp([])).toBe("ok")
  })
})

describe("buildProbeSpecs", () => {
  it("derives health URLs from service base URLs", () => {
    const specs = buildProbeSpecs({
      KICAD_SERVICE_URL: "http://kicad:3019",
      SIM_SERVICE_URL: "http://sim:3020/",
    } as NodeJS.ProcessEnv)

    expect(specs.find((s) => s.name === "kicad")?.url).toBe("http://kicad:3019/health")
    // A trailing slash on the base must not produce a doubled slash.
    expect(specs.find((s) => s.name === "sim")?.url).toBe("http://sim:3020/health")
    expect(specs.find((s) => s.name === "pytools")?.url).toBeUndefined()
  })
})

describe("probeHttp", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("reports up for a 200 response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok", { status: 200 })),
    )
    const result = await probeHttp({ name: "sim", url: "http://sim/health" })
    expect(result.status).toBe("up")
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it("reports down with the status code for a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 503 })),
    )
    const result = await probeHttp({ name: "sim", url: "http://sim/health" })
    expect(result).toMatchObject({ status: "down", detail: "HTTP 503" })
  })

  it("never throws when the dependency is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED")
      }),
    )
    const result = await probeHttp({ name: "sim", url: "http://sim/health" })
    expect(result).toMatchObject({ status: "down", detail: "ECONNREFUSED" })
  })

  it("reports disabled for an optional dependency with no URL", async () => {
    const result = await probeHttp({ name: "mouser", url: undefined, optional: true })
    expect(result.status).toBe("disabled")
  })
})

describe("GET /health", () => {
  afterEach(() => vi.unstubAllGlobals())

  /** A fully configured stack, so every probe actually issues a request. */
  const fullEnv = {
    KICAD_SERVICE_URL: "http://kicad:3019",
    SIM_SERVICE_URL: "http://sim:3020",
    PYTOOLS_SERVICE_URL: "http://pytools:3022",
    FREEROUTING_SERVICE_URL: "http://freerouting:3021",
    MEILI_URL: "http://meilisearch:7700",
  } as NodeJS.ProcessEnv

  it("returns a report without requiring an API key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok", { status: 200 })),
    )
    const app = createApp({
      version: "0.1.0",
      startedAt: Date.now(),
      apiKey: "secret",
      env: fullEnv,
    })

    const res = await request(app).get("/health").expect(200)

    expect(res.body).toMatchObject({ service: "api", version: "0.1.0", status: "ok" })
    expect(res.body.dependencies).toHaveLength(5)
    expect(res.body.uptimeSec).toBeGreaterThanOrEqual(0)
  })

  it("is also reachable at /api/health, for routing behind the proxy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok", { status: 200 })),
    )
    const app = createApp({
      version: "0.1.0",
      startedAt: Date.now(),
      apiKey: "secret",
      env: fullEnv,
    })

    await request(app).get("/api/health").expect(200)
  })

  it("returns 503 only when every dependency is down", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED")
      }),
    )
    const app = createApp({ version: "0.1.0", startedAt: Date.now(), env: fullEnv })

    const res = await request(app).get("/health")
    expect(res.status).toBe(503)
    expect(res.body.status).toBe("down")
  })

  it("stays 200 but degraded when only some dependencies are down", async () => {
    // A degraded stack is still serving designs; failing the container healthcheck here
    // would restart a working API because KiCad export is unavailable.
    let call = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1
        if (call === 1) throw new Error("ECONNREFUSED")
        return new Response("ok", { status: 200 })
      }),
    )
    const app = createApp({ version: "0.1.0", startedAt: Date.now(), env: fullEnv })

    const res = await request(app).get("/health").expect(200)
    expect(res.body.status).toBe("degraded")
    expect(
      res.body.dependencies.filter((d: { status: string }) => d.status === "down"),
    ).toHaveLength(1)
  })

  it("reports degraded when service URLs are unconfigured", async () => {
    const app = createApp({ version: "0.1.0", startedAt: Date.now(), env: {} as NodeJS.ProcessEnv })

    const res = await request(app).get("/health").expect(200)
    expect(res.body.status).toBe("degraded")
    expect(res.body.dependencies.every((d: { status: string }) => d.status === "unknown")).toBe(
      true,
    )
  })
})

describe("GET /live", () => {
  it("does not depend on anything external", async () => {
    // Liveness must never consult a dependency, or a flaky service restarts a healthy
    // process.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("should not be called")
      }),
    )
    const app = createApp({ version: "0.1.0", startedAt: Date.now() })

    await request(app).get("/live").expect(200, { status: "ok" })
    vi.unstubAllGlobals()
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
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok", { status: 200 })),
    )
    const app = createApp({ version: "0.1.0", startedAt: Date.now(), apiKey: "secret" })

    // Auth passes, so this reaches the 404 handler rather than the 401 one.
    await request(app).get("/api/designs").set("Authorization", "Bearer secret").expect(404)
    vi.unstubAllGlobals()
  })
})
