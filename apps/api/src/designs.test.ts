/**
 * The designs API and the store beneath it.
 *
 * The interesting behaviour is not the routing — it is that undo replays the log rather
 * than inverting operations, that two clients cannot silently overwrite each other, and
 * that a rejected operation comes back with a hint a caller can act on.
 */

import { beforeEach, describe, expect, it } from "vitest"
import request from "supertest"
import { createSequentialIdFactory, setIdFactory } from "@syntrix/shared"
import { t0Resolver } from "@syntrix/parts"
import { createApp } from "./app"
import { MemoryDesignStore, replay } from "./store"

const app = () => createApp({ version: "0.1.0", startedAt: Date.now(), env: {} })

const newDesign = async (client: ReturnType<typeof app>): Promise<string> => {
  const created = await request(client).post("/api/designs").send({ name: "test" }).expect(201)
  return created.body.id as string
}

const addResistor = (name: string) => ({
  operation: {
    type: "add_component",
    ftype: "simple_resistor",
    name,
    props: { resistance: "10k" },
  },
})

beforeEach(() => setIdFactory(createSequentialIdFactory()))

describe("designs CRUD", () => {
  it("creates, lists, reads and deletes", async () => {
    const client = app()
    const id = await newDesign(client)

    const list = await request(client).get("/api/designs").expect(200)
    expect(list.body.designs.map((d: { id: string }) => d.id)).toContain(id)

    const read = await request(client).get(`/api/designs/${id}`).expect(200)
    expect(read.body).toMatchObject({ id, version: 0, circuit: [] })
    // manualEdits travels with the design, not as a separate resource (ADR-0013).
    expect(read.body.manualEdits).toEqual({})

    await request(client).delete(`/api/designs/${id}`).expect(204)
    await request(client).get(`/api/designs/${id}`).expect(404)
  })

  it("answers 404 as problem+json, not as an empty body", async () => {
    const response = await request(app()).get("/api/designs/nope").expect(404)

    expect(response.headers["content-type"]).toMatch(/problem\+json/)
    expect(response.body.errors[0]).toMatchObject({ code: "ELEMENT_NOT_FOUND" })
    expect(response.body.errors[0].hint).toBeTruthy()
  })
})

describe("submitting operations", () => {
  it("applies one and advances the version", async () => {
    const client = app()
    const id = await newDesign(client)

    const response = await request(client)
      .post(`/api/designs/${id}/operations`)
      .send(addResistor("R1"))
      .expect(200)

    expect(response.body.version).toBe(1)
    expect(response.body.circuit.some((e: { type: string }) => e.type === "source_component")).toBe(
      true,
    )
  })

  it("rejects an operation the engine refuses, with the engine's own hint", async () => {
    const client = app()
    const id = await newDesign(client)

    const response = await request(client)
      .post(`/api/designs/${id}/operations`)
      .send({ operation: { type: "remove_component", component: "R9" } })
      .expect(422)

    expect(response.body.errors[0].code).toBe("COMPONENT_NOT_FOUND")
    // The hint is what turns a rejected call into a self-correcting agent rather than a
    // dead end, so it has to survive the trip through HTTP.
    expect(response.body.errors[0].hint).toBeTruthy()
  })

  it("rejects a body that is not an Operation at all", async () => {
    const client = app()
    const id = await newDesign(client)

    const response = await request(client)
      .post(`/api/designs/${id}/operations`)
      .send({ operation: { type: "definitely_not_an_operation" } })
      .expect(400)

    expect(response.headers["content-type"]).toMatch(/problem\+json/)
  })

  it("409s when the expected version has moved on", async () => {
    const client = app()
    const id = await newDesign(client)
    await request(client).post(`/api/designs/${id}/operations`).send(addResistor("R1")).expect(200)

    const stale = await request(client)
      .post(`/api/designs/${id}/operations`)
      .send({ ...addResistor("R2"), expectedVersion: 0 })
      .expect(409)

    // A conflict is worth retrying after a re-read; a validation failure never is, which
    // is why they are different status codes.
    expect(stale.body.errors[0].code).toBe("VERSION_CONFLICT")
    expect(stale.body.errors[0].details).toMatchObject({ currentVersion: 1, expectedVersion: 0 })
  })

  it("accepts a matching expected version", async () => {
    const client = app()
    const id = await newDesign(client)

    await request(client)
      .post(`/api/designs/${id}/operations`)
      .send({ ...addResistor("R1"), expectedVersion: 0 })
      .expect(200)
  })
})

describe("history, undo and redo", () => {
  it("records every operation with who asked for it", async () => {
    const client = app()
    const id = await newDesign(client)
    await request(client)
      .post(`/api/designs/${id}/operations`)
      .send({ ...addResistor("R1"), actor: { kind: "agent", runId: "run_1" } })
      .expect(200)

    const history = await request(client).get(`/api/designs/${id}/history`).expect(200)

    expect(history.body.entries).toHaveLength(1)
    expect(history.body.entries[0]).toMatchObject({
      seq: 1,
      actor: { kind: "agent", runId: "run_1" },
    })
    // Every element is traceable back to the operation and the agent turn that made it.
    expect(history.body.entries[0].operationId).toBeTruthy()
  })

  it("undo replays to the previous state and redo returns", async () => {
    const client = app()
    const id = await newDesign(client)
    await request(client).post(`/api/designs/${id}/operations`).send(addResistor("R1")).expect(200)
    await request(client).post(`/api/designs/${id}/operations`).send(addResistor("R2")).expect(200)

    const undone = await request(client).post(`/api/designs/${id}/undo`).expect(200)
    expect(undone.body.version).toBe(1)
    expect(names(undone.body.circuit)).toEqual(["R1"])

    const redone = await request(client).post(`/api/designs/${id}/redo`).expect(200)
    expect(redone.body.version).toBe(2)
    expect(names(redone.body.circuit).sort()).toEqual(["R1", "R2"])
  })

  it("undo works on an operation no inverse could undo", async () => {
    // A batch is one undo step. An inverse-operation scheme would have to know what each
    // child did and reverse them in order; replay does not care.
    const client = app()
    const id = await newDesign(client)
    await request(client)
      .post(`/api/designs/${id}/operations`)
      .send({
        operation: {
          type: "batch",
          ops: [
            { type: "add_component", ftype: "simple_resistor", name: "R1", props: {} },
            { type: "add_component", ftype: "simple_capacitor", name: "C1", props: {} },
            { type: "connect", a: { component: "R1", pin: 2 }, b: { component: "C1", pin: 1 } },
          ],
        },
      })
      .expect(200)

    const undone = await request(client).post(`/api/designs/${id}/undo`).expect(200)
    expect(undone.body.circuit).toEqual([])
  })

  it("refuses to undo past the beginning", async () => {
    const client = app()
    const id = await newDesign(client)

    const response = await request(client).post(`/api/designs/${id}/undo`).expect(422)
    expect(response.body.errors[0].message).toMatch(/nothing left to undo/i)
  })

  it("refuses to redo when there is nothing ahead", async () => {
    const client = app()
    const id = await newDesign(client)
    await request(client).post(`/api/designs/${id}/operations`).send(addResistor("R1")).expect(200)

    await request(client).post(`/api/designs/${id}/redo`).expect(422)
  })

  it("a new edit after an undo discards the redo tail", async () => {
    const client = app()
    const id = await newDesign(client)
    await request(client).post(`/api/designs/${id}/operations`).send(addResistor("R1")).expect(200)
    await request(client).post(`/api/designs/${id}/operations`).send(addResistor("R2")).expect(200)
    await request(client).post(`/api/designs/${id}/undo`).expect(200)

    await request(client).post(`/api/designs/${id}/operations`).send(addResistor("R3")).expect(200)

    // The log cannot branch, so redo has nowhere to go. This is what every editor does.
    await request(client).post(`/api/designs/${id}/redo`).expect(422)
    const read = await request(client).get(`/api/designs/${id}`).expect(200)
    expect(names(read.body.circuit).sort()).toEqual(["R1", "R3"])
  })
})

describe("the log is the truth", () => {
  it("a design folded from its log equals the one the store served", async () => {
    const store = new MemoryDesignStore({ resolvePart: t0Resolver })
    const record = await store.create("replayed")

    for (const name of ["R1", "R2", "C1"]) {
      const result = await store.submit(record.id, {
        type: "add_component",
        ftype: name.startsWith("R") ? "simple_resistor" : "simple_capacitor",
        name,
        props: {},
      })
      expect(result.ok).toBe(true)
    }

    const served = (await store.get(record.id))!.design
    const folded = replay(record.id, await store.history(record.id), 3, {
      resolvePart: t0Resolver,
    })

    expect(folded.ok).toBe(true)
    // Snapshots are a cache. Deleting every one of them must lose nothing.
    if (folded.ok) expect(folded.value.circuit).toEqual(served.circuit)
  })
})

describe("layout, ERC and summary", () => {
  it("lays a design out without changing it", async () => {
    const client = app()
    const id = await newDesign(client)
    await request(client).post(`/api/designs/${id}/operations`).send(addResistor("R1")).expect(200)

    const layout = await request(client).post(`/api/designs/${id}/layout`).expect(200)
    expect(
      layout.body.elements.some((e: { type: string }) => e.type === "schematic_component"),
    ).toBe(true)

    // Layout is a read: the design's version must not move.
    const read = await request(client).get(`/api/designs/${id}`).expect(200)
    expect(read.body.version).toBe(1)
  })

  it("runs ERC", async () => {
    const client = app()
    const id = await newDesign(client)
    await request(client).post(`/api/designs/${id}/operations`).send(addResistor("R1")).expect(200)

    const erc = await request(client).get(`/api/designs/${id}/erc`).expect(200)
    // A lone unconnected resistor has dangling pins and no ground — ERC must say so.
    expect(erc.body.violations.length).toBeGreaterThan(0)
  })

  it("serves a summary rather than the element array", async () => {
    const client = app()
    const id = await newDesign(client)
    await request(client).post(`/api/designs/${id}/operations`).send(addResistor("R1")).expect(200)

    const summary = await request(client).get(`/api/designs/${id}/summary`).expect(200)
    expect(summary.headers["content-type"]).toMatch(/text\/plain/)
    expect(summary.text).toContain("R1")
    // Principle 4: the model is never shown coordinates.
    expect(summary.text).not.toMatch(/schematic_component/)
  })
})

describe("parts routes", () => {
  it("searches T0 with no database running", async () => {
    const response = await request(app())
      .get("/api/parts/search")
      .query({ q: "3.3V LDO SOT-223" })
      .expect(200)

    expect(response.body.index).toBe("local")
    expect(
      response.body.results.some((r: { mpn?: string }) => (r.mpn ?? "").startsWith("AMS1117")),
    ).toBe(true)
  })

  it("serves a pinout without the whole part definition", async () => {
    const search = await request(app()).get("/api/parts/search").query({ q: "AMS1117" }).expect(200)
    const id = search.body.results[0].id

    const pinout = await request(app()).get(`/api/parts/${id}/pinout`).expect(200)

    expect(pinout.body.pins.length).toBeGreaterThan(0)
    expect(pinout.body.pins[0]).toHaveProperty("altNames")
    // Answering "which pin is VCC" should not cost the model a whole PartDefinition.
    expect(pinout.body).not.toHaveProperty("symbol")
  })

  it("404s an unknown part as problem+json", async () => {
    const response = await request(app()).get("/api/parts/nope/pinout").expect(404)
    expect(response.body.errors[0].code).toBe("PART_NOT_FOUND")
  })
})

const names = (circuit: Array<{ type: string; name?: string }>): string[] =>
  circuit.filter((e) => e.type === "source_component").map((e) => e.name!)
