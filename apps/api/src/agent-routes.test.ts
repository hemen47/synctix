/**
 * The agent surface, without a provider.
 *
 * These cover the parts that must work when no API key exists — which is the state every
 * developer's first run is in, and the state the UI has to render something sensible for.
 * The loop itself is covered by the eval suite in `@syntrix/agent` against a mock
 * provider; what is tested here is the HTTP skin around it, and the backend that turns a
 * tool name into an engine call.
 */

import { join } from "node:path"
import { describe, expect, it } from "vitest"
import request from "supertest"
import { createApp } from "./app"
import { MemoryDesignStore } from "./store"
import { createAgentBackend } from "./agent-backend"
import { LocalPartsIndex, T0_PARTS, t0Resolver } from "@syntrix/parts"

const app = () => createApp({ version: "test", startedAt: Date.now() })

describe("GET /api/agent/status", () => {
  it("reports every role, and stays available:false without keys", async () => {
    const response = await request(app()).get("/api/agent/status").expect(200)

    expect(response.body.roles.map((r: { role: string }) => r.role)).toEqual([
      "planner",
      "executor",
      "reviewer",
    ])
    // Each role names its provider and model even when it cannot run, because that is
    // what tells someone which key to set.
    for (const role of response.body.roles) {
      expect(role.provider).toBeTruthy()
      expect(role.model).toBeTruthy()
    }
    expect(response.body.limits.maxIterations).toBeGreaterThan(0)
  })
})

describe("POST /api/designs/:id/agent", () => {
  it("is 404 for a design that does not exist", async () => {
    await request(app())
      .post("/api/designs/design_missing/agent")
      .send({ prompt: "add a resistor" })
      .expect(404)
  })

  it("rejects an empty prompt before touching a provider", async () => {
    const store = new MemoryDesignStore({ resolvePart: t0Resolver })
    const created = await store.create("Test")

    await request(createApp({ version: "test", startedAt: Date.now(), store }))
      .post(`/api/designs/${created.id}/agent`)
      .send({ prompt: "" })
      .expect(400)
  })

  /**
   * The failure every first run hits. It must be a 503 with a hint, not a stream that
   * opens and then carries an error — a client cannot tell the second case from success
   * until it has already rendered a chat bubble.
   *
   * Driven from a fixture whose provider key can never be set, rather than from the
   * repo's own `models.yaml`: a developer with `OPENROUTER_API_KEY` exported would
   * otherwise make this test open a stream and call a real provider.
   */
  it("is 503 with an actionable hint when the provider has no key", async () => {
    const store = new MemoryDesignStore({ resolvePart: t0Resolver })
    const created = await store.create("Test")

    const response = await request(
      createApp({
        version: "test",
        startedAt: Date.now(),
        store,
        modelsConfigPath: join(import.meta.dirname, "__fixtures__", "models-no-key.yaml"),
      }),
    )
      .post(`/api/designs/${created.id}/agent`)
      .send({ prompt: "add a 10k resistor" })
      .expect(503)

    expect(response.body.errors[0].code).toBe("PROVIDER_ERROR")
    expect(response.body.errors[0].hint).toMatch(/API key/i)
    // The message names the variable to set, which is the only actionable part.
    expect(response.body.errors[0].message).toMatch(/SYNTRIX_TEST_ABSENT_KEY/)
  })
})

describe("the agent backend", () => {
  const backend = async () => {
    const store = new MemoryDesignStore({ resolvePart: t0Resolver })
    const created = await store.create("Test")
    return {
      store,
      designId: created.id,
      backend: createAgentBackend({
        store,
        designId: created.id,
        parts: new LocalPartsIndex(T0_PARTS),
        runId: "run_test",
      }),
    }
  }

  it("applies an operation through the engine and reports the new version", async () => {
    const { backend: agent } = await backend()

    const result = await agent.submit("add_component", { ftype: "simple_resistor", name: "R1" })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.summary).toMatch(/add_component applied/)
  })

  /** The property that makes a rejection recoverable: the engine's hint, not "failed". */
  it("returns the engine's own hint when an operation is rejected", async () => {
    const { backend: agent } = await backend()

    const result = await agent.submit("connect", {
      a: { component: "R1", pin: 1 },
      b: { component: "R2", pin: 1 },
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error[0]!.hint).toBeTruthy()
      expect(result.error[0]!.message).toBeTruthy()
    }
  })

  it("refuses a tool it does not know rather than silently doing nothing", async () => {
    const { backend: agent } = await backend()

    const result = await agent.read("delete_everything", {})

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error[0]!.code).toBe("TOOL_NOT_FOUND")
  })

  it("reads the design and the parts catalog", async () => {
    const { backend: agent } = await backend()

    const empty = await agent.read("inspect_design", {})
    expect(empty.ok && empty.value.summary).toMatch(/empty/i)

    const parts = await agent.read("search_parts", { query: "resistor" })
    expect(parts.ok).toBe(true)
  })

  it("runs ERC and reports a pass or fail the loop can act on", async () => {
    const { backend: agent } = await backend()
    const report = await agent.runErc()

    expect(typeof report.pass).toBe("boolean")
    expect(report.summary.length).toBeGreaterThan(0)
  })
})
