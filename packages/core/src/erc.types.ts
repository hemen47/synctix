/**
 * Electrical rule checking.
 *
 * ERC is a first-class product surface, not a lint pass: the agent loop is required to
 * run it before finishing a turn, so its output is written to be read by a model as well
 * as a human.
 */

export const ERC_RULES = [
  "dangling_pin",
  "single_pin_net",
  "output_output_short",
  "power_in_without_driver",
  "no_ground_reference",
  "missing_value",
  "duplicate_refdes",
  "unknown_part_pin",
] as const

export type ErcRuleId = (typeof ERC_RULES)[number]

export type ErcSeverity = "error" | "warning" | "info"

export interface ErcViolation {
  rule: ErcRuleId
  severity: ErcSeverity
  message: string
  /** What to do about it, written for an LLM reader. */
  hint: string
  elementIds: string[]
  /** Human-facing location, e.g. "U1 pin 3 (VCC)". */
  where?: string
}

export interface ErcReport {
  violations: ErcViolation[]
  errorCount: number
  warningCount: number
  /** True when there are no `error`-severity violations. */
  pass: boolean
  ranAt: string
}

export interface ErcOptions {
  /** Rules to skip, for designs that legitimately break one (e.g. a test fixture). */
  disabledRules?: ErcRuleId[]
  /** Treat warnings as errors. */
  strict?: boolean
}
