import { beforeEach, describe, expect, it } from "vitest"
import {
  createRandomIdFactory,
  createSequentialIdFactory,
  newElementId,
  newId,
  nextRefdes,
  refdesPrefixFor,
  setIdFactory,
} from "./ids"

describe("id factories", () => {
  it("produces deterministic ids sequentially, per prefix", () => {
    const factory = createSequentialIdFactory()
    expect(factory.next("source_component")).toBe("source_component_1")
    expect(factory.next("source_component")).toBe("source_component_2")
    // Counters are per prefix, so adding a port does not advance the component counter.
    expect(factory.next("source_port")).toBe("source_port_1")
    expect(factory.next("source_component")).toBe("source_component_3")
  })

  it("resets sequential counters", () => {
    const factory = createSequentialIdFactory()
    factory.next("x")
    factory.reset()
    expect(factory.next("x")).toBe("x_1")
  })

  it("produces unique ids from the random factory", () => {
    const factory = createRandomIdFactory()
    const ids = new Set(Array.from({ length: 2000 }, () => factory.next("el")))
    expect(ids.size).toBe(2000)
  })

  it("routes newId through the active factory", () => {
    setIdFactory(createSequentialIdFactory())
    expect(newId("thing")).toBe("thing_1")
    expect(newElementId("source_net")).toBe("source_net_1")
  })
})

describe("refdesPrefixFor", () => {
  it("follows schematic convention, not the ftype name", () => {
    // A simple_resistor is R1, not SR1.
    expect(refdesPrefixFor("simple_resistor")).toBe("R")
    expect(refdesPrefixFor("simple_capacitor")).toBe("C")
    expect(refdesPrefixFor("simple_inductor")).toBe("L")
    expect(refdesPrefixFor("simple_op_amp")).toBe("U")
    expect(refdesPrefixFor("simple_mosfet")).toBe("Q")
    expect(refdesPrefixFor("simple_pin_header")).toBe("J")
  })

  it("gives LEDs the diode prefix", () => {
    expect(refdesPrefixFor("simple_led")).toBe("D")
    expect(refdesPrefixFor("simple_diode")).toBe("D")
  })

  it("falls back to U for anything unrecognised", () => {
    expect(refdesPrefixFor("simple_flux_capacitor")).toBe("U")
  })
})

describe("nextRefdes", () => {
  beforeEach(() => setIdFactory(createSequentialIdFactory()))

  it("starts at 1 in an empty design", () => {
    expect(nextRefdes("simple_resistor", [])).toBe("R1")
  })

  it("continues after existing designators", () => {
    expect(nextRefdes("simple_resistor", ["R1", "R2"])).toBe("R3")
  })

  it("fills gaps left by deletions", () => {
    // Every schematic editor reuses R2 after it is deleted; jumping to R4 leaves the
    // designators sparse and confuses anyone reading the BOM.
    expect(nextRefdes("simple_resistor", ["R1", "R3"])).toBe("R2")
  })

  it("ignores designators belonging to other prefixes", () => {
    expect(nextRefdes("simple_capacitor", ["R1", "R2", "C1"])).toBe("C2")
  })

  it("ignores names that only look like designators", () => {
    // "R1A" and "RV1" are not resistors in the R series.
    expect(nextRefdes("simple_resistor", ["R1A", "RV1", "R1"])).toBe("R2")
  })

  it("handles a large existing set", () => {
    const existing = Array.from({ length: 50 }, (_, i) => `R${i + 1}`)
    expect(nextRefdes("simple_resistor", existing)).toBe("R51")
  })
})
