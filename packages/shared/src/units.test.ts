import { describe, expect, it } from "vitest"
import {
  formatSiValue,
  milToMm,
  mmToMil,
  parseSiValue,
  parseSiValueOr,
  snapToGrid,
  SCHEMATIC_GRID_MM,
} from "./units"

const value = (input: string | number): number => {
  const result = parseSiValue(input)
  if (!result.ok) throw new Error(`expected "${input}" to parse: ${result.error.message}`)
  return result.value.value
}

describe("parseSiValue", () => {
  it("parses plain numbers", () => {
    expect(value("100")).toBe(100)
    expect(value("0.5")).toBe(0.5)
    expect(value(".5")).toBe(0.5)
    expect(value("-12")).toBe(-12)
    expect(value(42)).toBe(42)
  })

  it("parses SI prefixes", () => {
    expect(value("10k")).toBe(10_000)
    expect(value("2.2M")).toBeCloseTo(2_200_000)
    expect(value("1G")).toBe(1e9)
    expect(value("100n")).toBeCloseTo(1e-7)
    expect(value("22p")).toBeCloseTo(2.2e-11)
    expect(value("4.7u")).toBeCloseTo(4.7e-6)
  })

  it("distinguishes mega from milli by case", () => {
    // The single most dangerous ambiguity in this domain: 1M is a megohm, 1m is a
    // milliohm, and confusing them is nine orders of magnitude.
    expect(value("1M")).toBe(1e6)
    expect(value("1m")).toBeCloseTo(1e-3)
  })

  it("accepts both micro signs", () => {
    // U+00B5 (micro sign) and U+03BC (greek mu) look identical and both occur in the
    // wild, including inside the same datasheet.
    expect(value("10µ")).toBeCloseTo(1e-5)
    expect(value("10μ")).toBeCloseTo(1e-5)
  })

  it("tolerates uppercase K", () => {
    // SI says lowercase, but "10K" is what people type.
    expect(value("10K")).toBe(10_000)
  })

  it("parses RKM codes, where the prefix replaces the decimal point", () => {
    expect(value("4k7")).toBe(4700)
    expect(value("1R2")).toBeCloseTo(1.2)
    expect(value("2M2")).toBeCloseTo(2.2e6)
    expect(value("6R8")).toBeCloseTo(6.8)
    expect(value("-4k7")).toBe(-4700)
  })

  it("keeps the unit separate from the prefix", () => {
    const result = parseSiValue("100nF")
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.value).toBeCloseTo(1e-7)
      expect(result.value.unit).toBe("F")
    }
  })

  it("handles a unit whose first letter is also a prefix", () => {
    // "1.27mm" is 1.27 millimetres, not 1.27 milli-metres-of-something-else: the first
    // "m" scales, the second is the unit.
    const result = parseSiValue("1.27mm")
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.value).toBeCloseTo(0.00127)
      expect(result.value.unit).toBe("m")
    }
  })

  it("parses ohms and percentages", () => {
    expect(parseSiValue("10kΩ").ok).toBe(true)
    expect(parseSiValue("5%").ok).toBe(true)
  })

  it("rejects empty and unparseable input with a hint", () => {
    const empty = parseSiValue("")
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(empty.error.hint).toContain("10k")

    const garbage = parseSiValue("not a value")
    expect(garbage.ok).toBe(false)
    if (!garbage.ok) expect(garbage.error.hint).toContain("SI prefix")
  })

  it("rejects non-finite numbers", () => {
    expect(parseSiValue(Number.NaN).ok).toBe(false)
    expect(parseSiValue(Number.POSITIVE_INFINITY).ok).toBe(false)
  })

  it("falls back rather than throwing when asked to", () => {
    expect(parseSiValueOr("garbage", 5)).toBe(5)
    expect(parseSiValueOr("10k", 5)).toBe(10_000)
  })
})

describe("formatSiValue", () => {
  it("round-trips through parseSiValue", () => {
    for (const original of [10_000, 1e-7, 2.2e6, 4700, 0.0047, 1e-12]) {
      const formatted = formatSiValue(original)
      expect(value(formatted)).toBeCloseTo(original, 12)
    }
  })

  it("formats with the expected prefix", () => {
    expect(formatSiValue(10_000)).toBe("10k")
    expect(formatSiValue(1e-7)).toBe("100n")
    expect(formatSiValue(4700, "Ω")).toBe("4.7kΩ")
    expect(formatSiValue(2.2e-6, "F")).toBe("2.2µF")
  })

  it("formats zero without a prefix", () => {
    expect(formatSiValue(0, "V")).toBe("0V")
  })

  it("does not leave trailing zeros", () => {
    // "10.0k" is what toPrecision gives; "10k" is what an engineer writes.
    expect(formatSiValue(10_000, "", 3)).toBe("10k")
  })
})

describe("mil and mm", () => {
  it("converts between mil and mm", () => {
    expect(milToMm(1000)).toBeCloseTo(25.4)
    expect(mmToMil(25.4)).toBeCloseTo(1000)
    expect(milToMm(50)).toBeCloseTo(SCHEMATIC_GRID_MM)
  })

  it("round-trips", () => {
    expect(mmToMil(milToMm(123))).toBeCloseTo(123)
  })
})

describe("snapToGrid", () => {
  it("snaps to the 50 mil schematic grid by default", () => {
    expect(snapToGrid(1.3)).toBeCloseTo(1.27)
    // 0.6 is less than half a grid step, so it snaps back to the origin.
    expect(snapToGrid(0.6)).toBeCloseTo(0)
    expect(snapToGrid(0.7)).toBeCloseTo(1.27)
  })

  it("snaps to a custom grid", () => {
    expect(snapToGrid(1.4, 0.5)).toBeCloseTo(1.5)
    expect(snapToGrid(-1.4, 0.5)).toBeCloseTo(-1.5)
  })

  it("leaves on-grid values untouched", () => {
    expect(snapToGrid(2.54)).toBeCloseTo(2.54)
  })
})
