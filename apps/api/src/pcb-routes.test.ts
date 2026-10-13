/**
 * Routing and export over HTTP.
 *
 * The routing test runs tscircuit's real autorouter, so it is slow. That is the point:
 * M9's criterion is a board with copper on it, and a mocked router would prove nothing
 * about whether the endpoint produces one.
 */

import { beforeEach, describe, expect, it } from "vitest"
import request from "supertest"
import { createSequentialIdFactory, setIdFactory } from "@syntrix/shared"
import { t0Resolver } from "@syntrix/parts"
import { createApp } from "./app"
import { MemoryDesignStore } from "./store"

const ROUTE_TIMEOUT = 120_000

const app = () =>
  createApp({
    version: "0.1.0",
    startedAt: Date.now(),
    store: new MemoryDesignStore({ resolvePart: t0Resolver }),
  })

/** Two placed 0402 parts and a trace — the smallest thing that is really a board. */
const BOARD_OPS = [
  {
    type: "add_component",
    ftype: "simple_resistor",
    name: "R1",
    props: { resistance: "10k", footprint: "0402" },
  },
  {
    type: "add_component",
    ftype: "simple_capacitor",
    name: "C1",
    props: { capacitance: "100nF", footprint: "0402" },
  },
  { type: "connect", a: { component: "R1", pin: 2 }, b: { component: "C1", pin: 1 } },
  { type: "move_component", component: "R1", center: { x: -4, y: 0 }, layer: "pcb" },
  { type: "move_component", component: "C1", center: { x: 4, y: 0 }, layer: "pcb" },
]

const buildBoard = async (client: ReturnType<typeof app>): Promise<string> => {
  const created = await request(client).post("/api/designs").send({ name: "board" }).expect(201)
  const id = created.body.id as string

  for (const operation of BOARD_OPS) {
    await request(client).post(`/api/designs/${id}/operations`).send({ operation }).expect(200)
  }
  return id
}

beforeEach(() => setIdFactory(createSequentialIdFactory()))

describe("POST /designs/:id/route", () => {
  it(
    "routes a board and records it in the log — M9's criterion",
    async () => {
      const client = app()
      const id = await buildBoard(client)

      const routed = await request(client).post(`/api/designs/${id}/route`).send({}).expect(200)

      expect(routed.body.traceCount).toBeGreaterThanOrEqual(1)
      expect(routed.body.padCount).toBe(4)
      // tscircuit reports a bad route as an element rather than by failing (ADR-0017), so
      // the endpoint says so explicitly instead of leaving it to a 200.
      expect(routed.body.routingFailed).toBe(false)

      // The board landed through an operation, so it is in the log and undoable.
      const history = await request(client).get(`/api/designs/${id}/history`).expect(200)
      const last = history.body.entries[history.body.entries.length - 1]
      expect(last.operation.type).toBe("merge_circuit_json")
      expect(last.actor.kind).toBe("system")

      const design = await request(client).get(`/api/designs/${id}`).expect(200)
      expect(design.body.circuit.some((e: { type: string }) => e.type === "pcb_trace")).toBe(true)
      expect(design.body.circuit.some((e: { type: string }) => e.type === "pcb_board")).toBe(true)
    },
    ROUTE_TIMEOUT,
  )

  it("refuses to route an empty design", async () => {
    const client = app()
    const created = await request(client).post("/api/designs").send({ name: "empty" }).expect(201)

    const response = await request(client)
      .post(`/api/designs/${created.body.id}/route`)
      .send({})
      .expect(422)

    expect(response.body.errors[0].code).toBe("LAYOUT_FAILED")
    expect(response.body.errors[0].hint).toBeTruthy()
  })

  it("404s an unknown design", async () => {
    await request(app()).post("/api/designs/nope/route").send({}).expect(404)
  })
})

describe("POST /designs/:id/export/:format", () => {
  it("exports a netlist", async () => {
    const client = app()
    const id = await buildBoard(client)

    const response = await request(client).post(`/api/designs/${id}/export/spice`).expect(200)

    expect(response.body.format).toBe("spice")
    expect(response.body.artifacts[0].filename).toMatch(/\.cir$/)
    expect(response.body.artifacts[0].text).toBeTruthy()
  })

  it("exports an engineering BOM listing every component", async () => {
    const client = app()
    const id = await buildBoard(client)

    const response = await request(client).post(`/api/designs/${id}/export/bom-csv`).expect(200)
    const csv = response.body.artifacts[0].text as string

    expect(csv).toContain("Designator")
    expect(csv).toContain("R1")
    expect(csv).toContain("C1")
  })

  it("exports an LTspice schematic", async () => {
    const client = app()
    const id = await buildBoard(client)

    const response = await request(client)
      .post(`/api/designs/${id}/export/ltspice-asc`)
      .send({ directive: ".tran 1m" })
      .expect(200)

    expect(response.body.artifacts[0].text).toContain("Version 4")
    expect(response.body.artifacts[0].text).toContain(".tran 1m")
  })

  it(
    "exports Gerbers once the board has been routed",
    async () => {
      const client = app()
      const id = await buildBoard(client)
      await request(client).post(`/api/designs/${id}/route`).send({}).expect(200)

      const response = await request(client).post(`/api/designs/${id}/export/gerber`).expect(200)

      // A real fabrication set: copper layers and a drill file.
      const names = (response.body.artifacts as Array<{ filename: string }>).map((a) => a.filename)
      expect(names.length).toBeGreaterThan(1)
      expect(names.some((n) => n.endsWith(".drl"))).toBe(true)
    },
    ROUTE_TIMEOUT,
  )

  it(
    "exports DSN as an escape hatch to another router",
    async () => {
      const client = app()
      const id = await buildBoard(client)
      await request(client).post(`/api/designs/${id}/route`).send({}).expect(200)

      const response = await request(client).post(`/api/designs/${id}/export/dsn`).expect(200)
      expect(response.body.artifacts[0].filename).toMatch(/\.dsn$/)
    },
    ROUTE_TIMEOUT,
  )

  it("names the formats it does have when asked for one it does not", async () => {
    const client = app()
    const id = await buildBoard(client)

    const response = await request(client).post(`/api/designs/${id}/export/dxf`).expect(404)

    expect(response.body.errors[0].code).toBe("EXPORTER_NOT_FOUND")
    expect(response.body.errors[0].hint).toContain("spice")
  })
})
