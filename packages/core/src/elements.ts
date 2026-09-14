/**
 * Element factories.
 *
 * Every element core produces is built here and immediately parsed through the matching
 * `circuit-json` schema, so a shape mismatch fails at construction with a precise error
 * rather than silently at export time. This is what makes principle 2 enforceable rather
 * than aspirational.
 *
 * Conventions follow tscircuit's own output, verified by evaluating a real circuit
 * (ADR-0007) — notably that values are stored twice (numeric plus display string) and
 * that alternate pin names live in `port_hints`.
 */

import * as cj from "circuit-json"
import type { AnyCircuitElement } from "circuit-json"
import type { Result, ValidationError } from "@syntrix/shared"
import {
  err,
  formatSiValue,
  newElementId,
  ok,
  parseSiValue,
  validationError,
} from "@syntrix/shared"

/** A pin, as core understands it before the parts layer enriches it. */
export interface PinSpec {
  number: number
  name: string
  /** Written to `port_hints`, which is how a pin becomes addressable by name. */
  hints: string[]
}

export interface FtypeSpec {
  pins: PinSpec[]
  /** Resistors and capacitors have no polarity, so ERC must not flag a "reversed" one. */
  pinsInterchangeable: boolean
  /** The circuit-json property this ftype's primary value lands in, e.g. "resistance". */
  valueProp?: string
  /** Unit appended to the display string, e.g. "Ω". */
  valueUnit?: string
}

const passive = (posHints: string[], negHints: string[]): PinSpec[] => [
  { number: 1, name: "pin1", hints: ["pin1", "1", ...posHints] },
  { number: 2, name: "pin2", hints: ["pin2", "2", ...negHints] },
]

/**
 * Minimal built-in pin definitions.
 *
 * Core deliberately knows only enough to build a valid element from a bare ftype. Rich
 * part definitions — real pinouts, footprints, SPICE models — live in `@syntrix/parts`
 * and reach core through a resolver, which keeps the dependency direction one-way.
 */
export const DEFAULT_FTYPE_SPECS: Record<string, FtypeSpec> = {
  simple_resistor: {
    pins: passive(["pos", "left"], ["neg", "right"]),
    pinsInterchangeable: true,
    valueProp: "resistance",
    valueUnit: "Ω",
  },
  simple_capacitor: {
    pins: passive(["pos", "anode", "left"], ["neg", "cathode", "right"]),
    pinsInterchangeable: true,
    valueProp: "capacitance",
    valueUnit: "F",
  },
  simple_inductor: {
    pins: passive(["pos", "left"], ["neg", "right"]),
    pinsInterchangeable: true,
    valueProp: "inductance",
    valueUnit: "H",
  },
  simple_diode: {
    pins: [
      { number: 1, name: "pin1", hints: ["pin1", "1", "anode", "pos", "left"] },
      { number: 2, name: "pin2", hints: ["pin2", "2", "cathode", "neg", "right"] },
    ],
    // A diode very much has polarity.
    pinsInterchangeable: false,
  },
  simple_led: {
    pins: [
      { number: 1, name: "pin1", hints: ["pin1", "1", "anode", "pos"] },
      { number: 2, name: "pin2", hints: ["pin2", "2", "cathode", "neg"] },
    ],
    pinsInterchangeable: false,
  },
  simple_ground: {
    pins: [{ number: 1, name: "pin1", hints: ["pin1", "1", "gnd", "ground"] }],
    pinsInterchangeable: true,
  },
  simple_power_source: {
    pins: [
      { number: 1, name: "pin1", hints: ["pin1", "1", "pos", "plus", "vcc"] },
      { number: 2, name: "pin2", hints: ["pin2", "2", "neg", "minus", "gnd"] },
    ],
    pinsInterchangeable: false,
    valueProp: "voltage",
    valueUnit: "V",
  },
  simple_voltage_source: {
    pins: [
      { number: 1, name: "pin1", hints: ["pin1", "1", "pos", "plus"] },
      { number: 2, name: "pin2", hints: ["pin2", "2", "neg", "minus"] },
    ],
    pinsInterchangeable: false,
    valueProp: "voltage",
    valueUnit: "V",
  },
}

export const ftypeSpec = (ftype: string): FtypeSpec | undefined => DEFAULT_FTYPE_SPECS[ftype]

/**
 * Parse an element through circuit-json, turning a Zod failure into our error shape.
 *
 * The `hint` is written for an LLM: a Zod issue path is not actionable on its own.
 */
const conform = <T>(
  schema: { safeParse: (input: unknown) => { success: boolean; data?: T; error?: unknown } },
  candidate: unknown,
  what: string,
  elementId: string,
): Result<T, ValidationError[]> => {
  const parsed = schema.safeParse(candidate)
  if (parsed.success && parsed.data !== undefined) return ok(parsed.data)

  const issues =
    (parsed.error as { issues?: Array<{ path: (string | number)[]; message: string }> })?.issues ??
    []
  const detail = issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")

  return err([
    validationError(
      "CIRCUIT_JSON_INVALID",
      `${what} does not conform to circuit-json: ${detail}`,
      `Check the property names and value types against the circuit-json schema for this element type. ${
        issues[0]?.path.length
          ? `The field "${issues[0].path.join(".")}" is the first problem.`
          : ""
      }`.trim(),
      [elementId],
      { issues },
    ),
  ])
}

export interface CreateComponentInput {
  ftype: string
  name: string
  props?: Record<string, string | number | boolean>
  /** Supplied when the component came from a catalog part, for provenance. */
  spec?: FtypeSpec
  sourceGroupId?: string
}

export interface CreatedComponent {
  component: AnyCircuitElement
  ports: AnyCircuitElement[]
}

/**
 * Build a `source_component` and its `source_port`s.
 *
 * Values are written twice, matching tscircuit: `resistance: 10000` alongside
 * `display_resistance: "10kΩ"`. Writing only the number discards what the author typed;
 * writing only the string breaks every consumer that computes with it.
 */
export const createComponent = (
  input: CreateComponentInput,
): Result<CreatedComponent, ValidationError[]> => {
  const spec = input.spec ?? ftypeSpec(input.ftype)

  if (!spec) {
    return err([
      validationError(
        "INVALID_PROP",
        `Unknown ftype "${input.ftype}".`,
        `Use a known circuit-json ftype such as ${Object.keys(DEFAULT_FTYPE_SPECS)
          .slice(0, 4)
          .join(", ")}, or add the component through a part reference so its pinout is known.`,
        [],
        { ftype: input.ftype },
      ),
    ])
  }

  const componentId = newElementId("source_component")
  const props = input.props ?? {}

  const candidate: Record<string, unknown> = {
    type: "source_component",
    source_component_id: componentId,
    ftype: input.ftype,
    name: input.name,
    are_pins_interchangeable: spec.pinsInterchangeable,
    ...(input.sourceGroupId ? { source_group_id: input.sourceGroupId } : {}),
  }

  // circuit-json makes a passive's value *required*: `source_simple_resistor` will not
  // validate without `resistance`. But placing a part and choosing its value later is a
  // normal workflow, and the agent legitimately adds a decoupling cap before deciding on
  // 100nF.
  //
  // So an omitted value defaults to 0, which keeps the document conformant at all times
  // (principle 2), and ERC's `missing_value` rule reports the zero. A zero-ohm resistor
  // is a real part, so ERC distinguishes "explicitly 0" from "never set" via the absence
  // of the display_* field.
  const hasValue = spec.valueProp !== undefined && (spec.valueProp in props || "value" in props)
  if (spec.valueProp && !hasValue) {
    candidate[spec.valueProp] = 0
  }

  // The primary value gets both representations; anything else passes straight through
  // for circuit-json to validate.
  for (const [key, raw] of Object.entries(props)) {
    if (key === spec.valueProp || key === "value") {
      const targetKey = spec.valueProp ?? key
      const parsed = parseSiValue(raw as string | number)
      if (!parsed.ok) {
        return err([
          validationError(
            "INVALID_PROP",
            `Could not read "${raw}" as a value for ${targetKey}.`,
            parsed.error.hint,
            [componentId],
            { prop: targetKey, value: raw },
          ),
        ])
      }
      candidate[targetKey] = parsed.value.value
      candidate[`display_${targetKey}`] =
        typeof raw === "string" ? raw : formatSiValue(parsed.value.value, spec.valueUnit ?? "")
    } else {
      candidate[key] = raw
    }
  }

  const componentResult = conform(
    cj.any_circuit_element,
    candidate,
    `Component "${input.name}"`,
    componentId,
  )
  if (!componentResult.ok) return componentResult

  const ports: AnyCircuitElement[] = []
  for (const pin of spec.pins) {
    const portId = newElementId("source_port")
    const portResult = conform(
      cj.any_circuit_element,
      {
        type: "source_port",
        source_port_id: portId,
        source_component_id: componentId,
        name: pin.name,
        pin_number: pin.number,
        // How a pin becomes addressable as "pos", "VCC" or "3" rather than only by
        // number (ADR-0007).
        port_hints: pin.hints,
      },
      `Port ${pin.name} of "${input.name}"`,
      portId,
    )
    if (!portResult.ok) return portResult
    ports.push(portResult.value as AnyCircuitElement)
  }

  return ok({ component: componentResult.value as AnyCircuitElement, ports })
}

export const createNet = (
  name: string,
  opts: { isPower?: boolean; isGround?: boolean } = {},
): Result<AnyCircuitElement, ValidationError[]> => {
  const netId = newElementId("source_net")
  return conform(
    cj.any_circuit_element,
    {
      type: "source_net",
      source_net_id: netId,
      name,
      // Mandatory in the schema even when empty (ADR-0003).
      member_source_group_ids: [],
      ...(opts.isPower ? { is_power: true } : {}),
      ...(opts.isGround ? { is_ground: true } : {}),
    },
    `Net "${name}"`,
    netId,
  ) as Result<AnyCircuitElement, ValidationError[]>
}

export const createTrace = (
  portIds: string[],
  netIds: string[] = [],
  displayName?: string,
): Result<AnyCircuitElement, ValidationError[]> => {
  const traceId = newElementId("source_trace")
  return conform(
    cj.any_circuit_element,
    {
      type: "source_trace",
      source_trace_id: traceId,
      connected_source_port_ids: portIds,
      connected_source_net_ids: netIds,
      ...(displayName ? { display_name: displayName } : {}),
    },
    "Trace",
    traceId,
  ) as Result<AnyCircuitElement, ValidationError[]>
}

/** Narrow an element by type without casting at every call site. */
export const isType = <T extends AnyCircuitElement["type"]>(
  element: AnyCircuitElement,
  type: T,
): element is Extract<AnyCircuitElement, { type: T }> => element.type === type

/**
 * Validate a whole document against circuit-json.
 *
 * Used by `merge_circuit_json` to vet anything arriving from TSX mode or an import, and
 * by the conformance tests to prove core never emits a non-spec element.
 */
export const validateCircuit = (
  elements: unknown[],
): Result<AnyCircuitElement[], ValidationError[]> => {
  const valid: AnyCircuitElement[] = []
  const errors: ValidationError[] = []

  elements.forEach((element, index) => {
    const parsed = cj.any_circuit_element.safeParse(element)
    if (parsed.success) {
      valid.push(parsed.data as AnyCircuitElement)
      return
    }
    const type = (element as { type?: string })?.type ?? "(no type field)"
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    errors.push(
      validationError(
        "CIRCUIT_JSON_INVALID",
        `Element ${index} (type "${type}") is not valid circuit-json: ${issues.join("; ")}`,
        `Every element must match a circuit-json schema exactly. Extra fields are not allowed — put anything non-spec in the design's meta sidecar instead.`,
        [],
        { index, type, issues },
      ),
    )
  })

  return errors.length > 0 ? err(errors) : ok(valid)
}
