/**
 * Custom parts over HTTP.
 *
 * The property worth testing hardest is that a custom part is *usable*, not just stored:
 * it has to appear in search, resolve its pinout through core when a component is added,
 * and be reachable by the agent. A part you can save and not place is the worst half of
 * this feature to ship.
 */

import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import request from "supertest"
import { createApp } from "./app"
import { createPartsStack } from "./parts-stack"
import { MemoryDesignStore } from "./store"

const scratch = (): string => join(mkdtempSync(join(tmpdir(), "syntrix-api-parts-")), "parts.json")

/** A fresh app with its own parts file, so no test can see another's library. */
const app = () => createApp({ version: "test", startedAt: Date.now(), userPartsPath: scratch() })

const sensor = {
  name: "BME280 module",
  description: "Temperature, humidity and pressure sensor",
  category: "sensor",
  footprinterString: "soic8",
  pins: [
    { number: 1, name: "VCC", kind: "power_in" },
    { number: 2, name: "GND", kind: "ground" },
    { number: 3, name: "SDA", kind: "bidirectional" },
    { number: 4, name: "SCL", kind: "input" },
  ],
}

describe("GET /api/parts/capabilities", () => {
  it("reports that parts can be added, and the prefix they get", async () => {
    const response = await request(app()).get("/api/parts/capabilities").expect(200)

    expect(response.body.canAddParts).toBe(true)
    expect(response.body.prefix).toBe("user:")
  })
})

describe("POST /api/parts", () => {
  it("stores a part and returns it with an id", async () => {
    const response = await request(app()).post("/api/parts").send(sensor).expect(201)

    expect(response.body.id).toBe("user:bme280_module")
    expect(response.body.pins).toHaveLength(4)
    // Never claimed as verified on the user's behalf.
    expect(response.body.footprint.verification).toBe("unverified")
  })

  it("makes the part findable in search, ranked above generic hits", async () => {
    const server = app()
    await request(server).post("/api/parts").send(sensor).expect(201)

    const found = await request(server).get("/api/parts/search?q=BME280").expect(200)
    expect(found.body.results[0].id).toBe("user:bme280_module")
  })

  it("serves the pinout the agent asks for", async () => {
    const server = app()
    await request(server).post("/api/parts").send(sensor).expect(201)

    const pinout = await request(server).get("/api/parts/user:bme280_module/pinout").expect(200)
    expect(pinout.body.pins.map((p: { name: string }) => p.name)).toEqual([
      "VCC",
      "GND",
      "SDA",
      "SCL",
    ])
  })

  /**
   * The expensive mistake, refused rather than warned about: a board that comes back from
   * the fab with nowhere to solder half the pins.
   */
  it("refuses a footprint with fewer pads than the part has pins, and says so", async () => {
    const response = await request(app())
      .post("/api/parts")
      .send({ ...sensor, footprinterString: "0402" })
      .expect(422)

    expect(response.body.errors[0].code).toBe("FOOTPRINT_UNRESOLVED")
    expect(response.body.errors[0].message).toMatch(/pad/)
    expect(response.body.errors[0].hint).toBeTruthy()
  })

  it("refuses duplicate pin numbers", async () => {
    const response = await request(app())
      .post("/api/parts")
      .send({
        ...sensor,
        footprinterString: "",
        pins: [
          { number: 1, name: "A" },
          { number: 1, name: "B" },
        ],
      })
      .expect(422)

    expect(response.body.errors[0].code).toBe("PIN_MAP_INCOMPLETE")
  })

  it("refuses a part with no name", async () => {
    await request(app())
      .post("/api/parts")
      .send({ ...sensor, name: "" })
      .expect(400)
  })
})

/**
 * The point of the whole feature: a part you defined behaves like any other part in the
 * catalog, including through core's resolver when a component is actually added.
 */
describe("using a custom part in a design", () => {
  it("adds a component by partRef and wires it by pin name", async () => {
    const server = app()
    await request(server).post("/api/parts").send(sensor).expect(201)

    const design = await request(server).post("/api/designs").send({ name: "Custom" }).expect(201)
    const id = design.body.id as string

    const added = await request(server)
      .post(`/api/designs/${id}/operations`)
      .send({
        operation: { type: "add_component", partRef: "user:bme280_module", name: "U1", props: {} },
      })
      .expect(200)
    expect(added.body.version).toBe(1)

    // By pin *name*, which only works because the resolver turned altNames and names into
    // port hints — the thing that makes a custom part feel like a real one.
    await request(server)
      .post(`/api/designs/${id}/operations`)
      .send({ operation: { type: "create_net", name: "GND", isGround: true } })
      .expect(200)

    await request(server)
      .post(`/api/designs/${id}/operations`)
      .send({
        operation: { type: "connect", a: { component: "U1", pin: "GND" }, b: { net: "GND" } },
      })
      .expect(200)
  })
})

/**
 * The regression this file exists for.
 *
 * The bootstrap builds a store *before* `createApp` runs, because a store needs a
 * resolver. When it built its own from `t0Resolver`, a custom part could be saved,
 * searched and fetched over HTTP and then rejected by `add_component` with
 * `PART_NOT_FOUND` — every read path worked and the one write path that mattered did not.
 * Passing the same stack to both is what fixes it, so the test drives that shape: a store
 * supplied from outside, exactly as `index.ts` supplies one.
 */
describe("a store built by the bootstrap", () => {
  it("resolves custom parts, because it shares the app's parts stack", async () => {
    const stack = createPartsStack(scratch())
    const store = new MemoryDesignStore({ resolvePart: stack.resolvePart })
    const server = createApp({
      version: "test",
      startedAt: Date.now(),
      store,
      partsStack: stack,
    })

    await request(server).post("/api/parts").send(sensor).expect(201)

    const design = await request(server).post("/api/designs").send({ name: "Boot" }).expect(201)
    await request(server)
      .post(`/api/designs/${design.body.id}/operations`)
      .send({
        operation: { type: "add_component", partRef: "user:bme280_module", name: "U1", props: {} },
      })
      .expect(200)
  })
})

describe("DELETE /api/parts/:id", () => {
  it("deletes a part the user defined", async () => {
    const server = app()
    await request(server).post("/api/parts").send(sensor).expect(201)

    await request(server).delete("/api/parts/user:bme280_module").expect(204)
    await request(server).get("/api/parts/user:bme280_module").expect(404)
  })

  /** A quietly redefined or deleted built-in resistor is a trap nobody should hit. */
  it("refuses to delete a built-in part", async () => {
    const response = await request(app()).delete("/api/parts/t0:resistor").expect(403)

    expect(response.body.errors[0].hint).toMatch(/user:/)
    // And it is still there.
    await request(app()).get("/api/parts/t0:resistor").expect(200)
  })

  it("is 404 for a custom part that does not exist", async () => {
    await request(app()).delete("/api/parts/user:never_existed").expect(404)
  })
})
