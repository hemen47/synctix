/**
 * Error taxonomy.
 *
 * Every domain error is LLM-readable by construction: a stable machine `code`, a human
 * `message`, a `hint` that says what to do instead, and the `elementIds` involved. The
 * hint is the field that turns a rejected tool call into a self-correcting agent, so it
 * is required, not optional.
 */

export const ERROR_CODES = [
  // document / operation validation
  "UNKNOWN_OPERATION",
  "INVALID_OPERATION",
  "ELEMENT_NOT_FOUND",
  "COMPONENT_NOT_FOUND",
  "PORT_NOT_FOUND",
  "NET_NOT_FOUND",
  "DUPLICATE_NAME",
  "DUPLICATE_ID",
  "INVALID_PROP",
  "UNKNOWN_PIN",
  "PORT_ALREADY_CONNECTED",
  "NOT_CONNECTED",
  "SELF_CONNECTION",
  "CIRCUIT_JSON_INVALID",
  "MERGE_CONFLICT",
  "VERSION_CONFLICT",
  // parts
  "PART_NOT_FOUND",
  "PART_SOURCE_DISABLED",
  "FOOTPRINT_UNRESOLVED",
  "PIN_MAP_INCOMPLETE",
  // erc
  "ERC_VIOLATION",
  // layout / export / sim
  "LAYOUT_FAILED",
  "EXPORTER_NOT_FOUND",
  "EXPORT_FAILED",
  "SIMULATOR_NOT_FOUND",
  "SIM_FAILED",
  "NETLIST_FAILED",
  // agent
  "TOOL_NOT_FOUND",
  "AGENT_MAX_ITERATIONS",
  "PROVIDER_ERROR",
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

export interface ValidationError {
  /** Stable machine-readable code. Never reworded — clients may switch on it. */
  code: ErrorCode
  /** What went wrong, in plain language. */
  message: string
  /** What to do instead. Written for an LLM reader. */
  hint: string
  /** Elements the error concerns, so a UI can highlight them. */
  elementIds: string[]
  /** Optional structured payload for machine consumers. */
  details?: Record<string, unknown>
}

export const validationError = (
  code: ErrorCode,
  message: string,
  hint: string,
  elementIds: string[] = [],
  details?: Record<string, unknown>,
): ValidationError => ({ code, message, hint, elementIds, ...(details ? { details } : {}) })

/**
 * Thrown only for programmer error — a broken invariant that no user input should be
 * able to reach. Domain failures use `Result<T, ValidationError[]>` instead.
 */
export class SyntrixInternalError extends Error {
  override readonly name = "SyntrixInternalError"
  constructor(
    message: string,
    readonly context?: Record<string, unknown>,
  ) {
    super(message)
  }
}

/** RFC 9457 problem+json, the wire format for API errors. */
export interface ProblemDetails {
  type: string
  title: string
  status: number
  detail?: string
  instance?: string
  errors?: ValidationError[]
}

export const toProblemDetails = (
  status: number,
  title: string,
  errors: ValidationError[],
  instance?: string,
): ProblemDetails => ({
  type: `https://syntrix.dev/problems/${title.toLowerCase().replace(/\s+/g, "-")}`,
  title,
  status,
  ...(errors[0] ? { detail: errors[0].message } : {}),
  ...(instance ? { instance } : {}),
  errors,
})
