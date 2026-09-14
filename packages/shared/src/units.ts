/**
 * SI unit parsing and formatting.
 *
 * **Scope matters here.** `circuit-json` parses SI strings on its own element schemas —
 * `source_simple_resistor.parse({ resistance: "10k" })` yields `10000` (ADR-0003). This
 * module is for *our* values: layout spacing, board dimensions, tolerances, constraint
 * distances, and for validating user input before it reaches circuit-json so we can give
 * a better error than a Zod issue.
 *
 * Never run a value through both. Double-parsing "10k" is silent and wrong.
 */

import type { Result } from "./result"
import { err, ok } from "./result"

/** Engineering prefixes. Case matters: `M` is mega, `m` is milli. */
const PREFIXES: Record<string, number> = {
  T: 1e12,
  G: 1e9,
  M: 1e6,
  k: 1e3,
  K: 1e3, // tolerated: "10K" is common in practice even though SI says lowercase
  "": 1,
  d: 1e-1,
  c: 1e-2,
  m: 1e-3,
  u: 1e-6,
  µ: 1e-6, // U+00B5 micro sign
  μ: 1e-6, // U+03BC greek small letter mu — visually identical, different codepoint
  n: 1e-9,
  p: 1e-12,
  f: 1e-15,
}

/**
 * Matches a number with an optional prefix and unit, including the RKM convention where
 * the prefix replaces the decimal point: `4k7` is 4700, `1R2` is 1.2.
 */
const RKM_PATTERN = /^([+-]?\d+)([TGMkKdcmuµμnpfR])(\d+)$/
const VALUE_PATTERN = /^([+-]?(?:\d+\.?\d*|\.\d+))\s*([TGMkKdcmuµμnpfR]?)\s*([a-zA-ZΩ%°]*)$/

export interface ParsedValue {
  value: number
  /** The unit as written, e.g. "F", "Ω", "Hz". Empty when the input had none. */
  unit: string
}

export class UnitParseError {
  readonly code = "INVALID_UNIT" as const
  constructor(
    readonly message: string,
    readonly hint: string,
    readonly input: string,
  ) {}
}

/**
 * Parse an engineering value string into a number.
 *
 * ```
 * parseSiValue("10k")    -> 10000
 * parseSiValue("100n")   -> 1e-7
 * parseSiValue("4k7")    -> 4700
 * parseSiValue("1.27mm") -> 0.00127   (with unit "mm")
 * ```
 */
export const parseSiValue = (input: string | number): Result<ParsedValue, UnitParseError> => {
  if (typeof input === "number") {
    return Number.isFinite(input)
      ? ok({ value: input, unit: "" })
      : err(new UnitParseError("Value is not finite.", "Provide a finite number.", String(input)))
  }

  const trimmed = input.trim()
  if (trimmed === "") {
    return err(
      new UnitParseError("Value is empty.", 'Provide a value such as "10k" or "100n".', input),
    )
  }

  // RKM first: "4k7" would otherwise parse as 4 with a trailing "7" unit.
  const rkm = RKM_PATTERN.exec(trimmed)
  if (rkm) {
    const [, whole, prefix, frac] = rkm as unknown as [string, string, string, string]
    // "R" marks the decimal point without scaling: 1R2 is 1.2 ohms.
    const multiplier = prefix === "R" ? 1 : PREFIXES[prefix]
    if (multiplier === undefined) {
      return err(
        new UnitParseError(`Unknown prefix "${prefix}".`, "Use one of T G M k m u n p f.", input),
      )
    }
    const negative = whole.startsWith("-")
    const magnitude = Math.abs(Number(whole)) + Number(`0.${frac}`)
    return ok({ value: (negative ? -magnitude : magnitude) * multiplier, unit: "" })
  }

  const match = VALUE_PATTERN.exec(trimmed)
  if (!match) {
    return err(
      new UnitParseError(
        `Could not parse "${input}" as a value.`,
        'Use a number with an optional SI prefix and unit, such as "10k", "100nF", "1.27mm" or "4k7".',
        input,
      ),
    )
  }

  const [, numberPart, prefixPart, unitPart] = match as unknown as [string, string, string, string]

  // A bare unit whose first letter looks like a prefix is ambiguous: in "10mm" the first
  // "m" is milli and the rest is the unit, but in "10m" alone it is milli with no unit.
  // The regex has already split them, so the only fix-up needed is "R" used as a unit.
  const multiplier = prefixPart === "R" ? 1 : (PREFIXES[prefixPart] ?? 1)
  const value = Number(numberPart) * multiplier

  if (!Number.isFinite(value)) {
    return err(
      new UnitParseError(`"${input}" is not a finite value.`, "Provide a finite number.", input),
    )
  }

  return ok({ value, unit: unitPart })
}

/** Parse, or fall back. For places where a bad value should not stop the world. */
export const parseSiValueOr = (input: string | number, fallback: number): number => {
  const result = parseSiValue(input)
  return result.ok ? result.value.value : fallback
}

const FORMAT_STEPS: Array<[number, string]> = [
  [1e12, "T"],
  [1e9, "G"],
  [1e6, "M"],
  [1e3, "k"],
  [1, ""],
  [1e-3, "m"],
  [1e-6, "µ"],
  [1e-9, "n"],
  [1e-12, "p"],
  [1e-15, "f"],
]

/**
 * Format a number as an engineering value. The inverse of `parseSiValue` for display —
 * `10000` becomes `"10k"`, `1e-7` becomes `"100n"`.
 */
export const formatSiValue = (value: number, unit = "", significantDigits = 3): string => {
  if (value === 0) return `0${unit}`
  if (!Number.isFinite(value)) return String(value)

  const magnitude = Math.abs(value)
  const step = FORMAT_STEPS.find(([threshold]) => magnitude >= threshold) ?? [1e-15, "f"]
  const [divisor, prefix] = step as [number, string]

  const scaled = value / divisor
  // toPrecision keeps significant digits, but leaves "10.0" where "10" reads better.
  const text = Number(scaled.toPrecision(significantDigits)).toString()
  return `${text}${prefix}${unit}`
}

/** Millimetres per inch, for the mil/mm conversions schematic and PCB work require. */
export const MM_PER_INCH = 25.4
/** The schematic grid: 50 mil, the convention every symbol library is drawn on. */
export const SCHEMATIC_GRID_MM = 1.27

export const milToMm = (mil: number): number => (mil * MM_PER_INCH) / 1000
export const mmToMil = (mm: number): number => (mm * 1000) / MM_PER_INCH

/** Snap a coordinate to the grid. Off-grid pins do not connect in most EDA tools. */
export const snapToGrid = (value: number, gridMm = SCHEMATIC_GRID_MM): number =>
  Math.round(value / gridMm) * gridMm
