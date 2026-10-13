/**
 * Custom parts.
 *
 * The assertions that matter here are the refusals. A custom part is the one place a user
 * can put a wrong pinout or an impossible footprint into the system by hand, and every
 * downstream consumer — the canvas, the agent, the exporters — trusts what it finds.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  CompositePartsIndex,
  LocalPartsIndex,
  T0_PARTS,
  UserPartsIndex,
  buildUserPart,
  type UserPartInput,
} from "./index"

const scratch = (): string => join(mkdtempSync(join(tmpdir(), "syntrix-parts-")), "user-parts.json")

const input = (over: Partial<UserPartInput> = {}): UserPartInput => ({
  name: "My Sensor",
  description: "A sensor I have in a drawer",
  footprinterString: "soic8",
  pins: [
    { number: 1, name: "VCC", kind: "power_in" },
    { number: 2, name: "GND", kind: "ground" },
    { number: 3, name: "SDA", kind: "bidirectional" },
    { number: 4, name: "SCL", kind: "input" },
  ],
  ...over,
})

describe("buildUserPart", () => {
  it("builds a valid part from the fields a person can supply", () => {
    const result = buildUserPart(input())

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.id).toBe("user:my_sensor")
    expect(result.value.pins).toHaveLength(4)
    // Never claimed as verified on the user's behalf: the flag means "checked against a
    // datasheet or a trusted library", and that is what puts the warning in the palette.
    expect(result.value.footprint.verification).toBe("unverified")
    expect(result.value.provenance.source).toBe("user")
  })

  it("refuses a part with no pins", () => {
    const result = buildUserPart(input({ pins: [] }))

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error[0]!.code).toBe("PIN_MAP_INCOMPLETE")
  })

  it("refuses duplicate pin numbers, which would make a connection ambiguous", () => {
    const result = buildUserPart(
      input({
        pins: [
          { number: 1, name: "A" },
          { number: 1, name: "B" },
        ],
      }),
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.some((e) => /more than once/.test(e.message))).toBe(true)
    }
  })

  /** The expensive failure: a board that comes back from the fab and does not fit. */
  it("refuses a footprint with fewer pads than the part has pins", () => {
    const result = buildUserPart(input({ footprinterString: "0402" }))

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.some((e) => e.code === "FOOTPRINT_UNRESOLVED")).toBe(true)
      expect(result.error.some((e) => /pad/.test(e.message))).toBe(true)
    }
  })

  it("refuses a footprinter string that resolves to nothing", () => {
    const result = buildUserPart(input({ footprinterString: "not_a_real_package" }))

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error[0]!.hint).toBeTruthy()
  })

  /** A schematic-only part is legitimate — you cannot always know the package yet. */
  it("allows a part with no footprint at all", () => {
    const result = buildUserPart(input({ footprinterString: "" }))
    expect(result.ok).toBe(true)
  })

  it("needs a name", () => {
    const result = buildUserPart(input({ name: "   " }))
    expect(result.ok).toBe(false)
  })
})

describe("UserPartsIndex", () => {
  it("persists across instances, because a restart must not lose the library", async () => {
    const path = scratch()
    const built = buildUserPart(input())
    expect(built.ok).toBe(true)
    if (!built.ok) return

    const first = new UserPartsIndex(path)
    await first.upsert([built.value])

    const second = new UserPartsIndex(path)
    expect(await second.get("user:my_sensor")).toBeDefined()
    expect((await second.status()).count).toBe(1)
  })

  it("removes a part and writes the removal through", async () => {
    const path = scratch()
    const built = buildUserPart(input())
    if (!built.ok) throw new Error("fixture failed to build")

    const index = new UserPartsIndex(path)
    await index.upsert([built.value])
    expect(await index.remove(["user:my_sensor"])).toEqual({ removed: 1 })

    expect(await new UserPartsIndex(path).get("user:my_sensor")).toBeUndefined()
  })

  it("starts empty rather than throwing when the file does not exist", async () => {
    const index = new UserPartsIndex(scratch())
    expect((await index.status()).count).toBe(0)
  })

  /** One bad entry must not cost the user every other part they defined. */
  it("skips an invalid entry and keeps the rest", async () => {
    const path = scratch()
    const built = buildUserPart(input())
    if (!built.ok) throw new Error("fixture failed to build")

    writeFileSync(
      path,
      JSON.stringify({ parts: [{ id: "user:broken" }, built.value] }, undefined, 2),
      "utf8",
    )

    const index = new UserPartsIndex(path)
    expect((await index.status()).count).toBe(1)
    expect(await index.get("user:my_sensor")).toBeDefined()
  })

  it("survives a file that is not JSON at all", async () => {
    const path = scratch()
    writeFileSync(path, "this is not json", "utf8")
    expect((await new UserPartsIndex(path).status()).count).toBe(0)
  })

  it("writes valid JSON that a person could read and edit", async () => {
    const path = scratch()
    const built = buildUserPart(input())
    if (!built.ok) throw new Error("fixture failed to build")

    await new UserPartsIndex(path).upsert([built.value])

    const written = JSON.parse(readFileSync(path, "utf8")) as { parts: unknown[] }
    expect(written.parts).toHaveLength(1)
  })
})

describe("CompositePartsIndex", () => {
  const composite = async () => {
    const user = new UserPartsIndex(scratch())
    const built = buildUserPart(input({ name: "Custom Resistor Thing" }))
    if (!built.ok) throw new Error("fixture failed to build")
    await user.upsert([built.value])
    return new CompositePartsIndex(user, new LocalPartsIndex(T0_PARTS))
  }

  it("finds both custom and built-in parts", async () => {
    const index = await composite()

    expect(await index.get("user:custom_resistor_thing")).toBeDefined()
    expect(await index.get("t0:resistor")).toBeDefined()
  })

  it("ranks the user's own parts above generic ones", async () => {
    const index = await composite()
    const results = await index.search("resistor")

    expect(results[0]!.id).toBe("user:custom_resistor_thing")
    expect(results.length).toBeGreaterThan(1)
  })

  it("honours the result limit across both sources", async () => {
    const index = await composite()
    expect(await index.search("resistor", { limit: 2 })).toHaveLength(2)
  })

  /** The built-in catalog is not editable: a quietly redefined resistor is a trap. */
  it("writes only to the overlay", async () => {
    const user = new UserPartsIndex(scratch())
    const base = new LocalPartsIndex(T0_PARTS)
    const index = new CompositePartsIndex(user, base)

    const built = buildUserPart(input())
    if (!built.ok) throw new Error("fixture failed to build")
    await index.upsert([built.value])

    expect(await user.get("user:my_sensor")).toBeDefined()
    expect(await base.get("user:my_sensor")).toBeUndefined()
  })
})
