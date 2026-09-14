/**
 * Electrical rule checking.
 *
 * ERC is a product surface, not a lint pass: the agent loop must run it before finishing
 * a turn, so every violation carries a `hint` a model can act on and a `where` a human
 * can find on the canvas.
 *
 * Where circuit-json already models pin semantics (`requires_power`, `provides_ground`,
 * `must_be_connected`, `do_not_connect`), the rules read those fields rather than a
 * parallel system of our own (ADR-0007).
 */

import type { AnyCircuitElement } from "circuit-json"
import type { Design } from "./types"
import type { ErcOptions, ErcReport, ErcRuleId, ErcViolation } from "./erc.types"
import { buildIndex, connectedPorts, describePort, electricalNets } from "./index-view"
import type { IndexedView } from "./index-view"
import { ftypeSpec } from "./elements"

type Port = Extract<AnyCircuitElement, { type: "source_port" }>

interface RuleContext {
  design: Design
  view: IndexedView
}

type Rule = (ctx: RuleContext) => ErcViolation[]

// ---------------------------------------------------------------- rules

/** A pin connected to nothing at all. */
const danglingPin: Rule = ({ view }) => {
  const violations: ErcViolation[] = []

  for (const port of view.ports.values()) {
    if (port.do_not_connect) continue
    const traces = view.tracesByPort.get(port.source_port_id) ?? []
    if (traces.length > 0) continue

    const where = describePort(view, port)
    violations.push({
      rule: "dangling_pin",
      // A pin explicitly marked as needing a connection is an error; anything else is a
      // warning, because unused pins on a connector or an IC are routine.
      severity: port.must_be_connected ? "error" : "warning",
      message: `${where} is not connected to anything.`,
      hint: `Connect ${where} to a net or another pin, or leave it deliberately unconnected if that is intended.`,
      elementIds: [port.source_port_id],
      where,
    })
  }

  return violations
}

/**
 * A named net carrying exactly one pin.
 *
 * The value of this check is catching a mistyped net name — connecting to "VOUTT" when
 * "VOUT" was meant creates a net with one member and silently breaks the circuit.
 *
 * But a single-pin net is often entirely correct: VIN on an RC filter has one pin,
 * because it is the circuit's interface to the outside world. Power and ground rails are
 * the same. So this reports at `info` severity and exempts power and ground rails
 * outright — it is a lead worth following, not a defect. KiCad behaves the same way:
 * what it errors on is an unconnected *pin*, which `dangling_pin` already covers.
 */
const singlePinNet: Rule = ({ view }) => {
  const violations: ErcViolation[] = []

  for (const net of electricalNets(view)) {
    if (net.ports.size !== 1) continue

    const portId = [...net.ports][0] as string
    const port = view.ports.get(portId)
    if (!port || port.do_not_connect) continue
    // A pin connected to nothing at all is `dangling_pin`'s business, not this rule's.
    if ((view.tracesByPort.get(portId) ?? []).length === 0) continue

    // Rails legitimately have one member on a small sheet.
    const isRail = [...net.netIds].some((id) => {
      const element = view.nets.get(id) as unknown as Record<string, unknown> | undefined
      return Boolean(element?.["is_power"] || element?.["is_ground"])
    })
    if (isRail) continue
    if (net.name && /^(gnd|ground|vss|agnd|dgnd|vcc|vdd|v\+|\+\d)/i.test(net.name)) continue

    const where = describePort(view, port)
    violations.push({
      rule: "single_pin_net",
      severity: "info",
      message: `Net ${net.name ?? "(unnamed)"} has only one pin on it (${where}).`,
      hint: `This is correct for an input or output that leaves the sheet. If it was not intended, check for a misspelled net name — a typo creates a second net that connects nothing.`,
      elementIds: [portId, ...net.netIds],
      where,
    })
  }

  return violations
}

/** Two driving outputs shorted together. */
const outputOutputShort: Rule = ({ view }) => {
  const violations: ErcViolation[] = []

  for (const net of electricalNets(view)) {
    const drivers = [...net.ports]
      .map((id) => view.ports.get(id))
      .filter((p): p is Port => Boolean(p))
      // `provides_power` is a flag, but `provides_voltage` is a *value* (the volts the
      // pin supplies), so it is tested for presence rather than truthiness — a pin
      // supplying 0 V still drives the node.
      .filter(
        (p) => (p.provides_power || p.provides_voltage !== undefined) && !p.can_use_open_drain,
      )

    if (drivers.length < 2) continue

    const where = drivers.map((p) => describePort(view, p)).join(", ")
    violations.push({
      rule: "output_output_short",
      severity: "error",
      message: `Multiple driving pins are shorted together on one net: ${where}.`,
      hint: "Two outputs driving the same node will fight. Remove one connection, or use open-drain pins with a pull-up if wire-OR is intended.",
      elementIds: drivers.map((p) => p.source_port_id),
      where,
    })
  }

  return violations
}

/** A pin that needs power sitting on a net nothing drives. */
const powerInWithoutDriver: Rule = ({ view }) => {
  const violations: ErcViolation[] = []

  for (const net of electricalNets(view)) {
    const ports = [...net.ports]
      .map((id) => view.ports.get(id))
      .filter((p): p is Port => Boolean(p))
    // Same asymmetry as above: `requires_voltage` carries the volts needed, so 0 must
    // not read as "needs nothing".
    const consumers = ports.filter((p) => p.requires_power || p.requires_voltage !== undefined)
    if (consumers.length === 0) continue

    const driven =
      ports.some((p) => p.provides_power || p.provides_voltage !== undefined) ||
      // A net explicitly flagged as a power rail counts as driven — the supply may be
      // off-sheet.
      [...net.netIds].some((id) => {
        const netElement = view.nets.get(id)
        return Boolean((netElement as unknown as Record<string, unknown> | undefined)?.["is_power"])
      })

    if (driven) continue

    const where = consumers.map((p) => describePort(view, p)).join(", ")
    violations.push({
      rule: "power_in_without_driver",
      severity: "error",
      message: `${where} needs power, but nothing on that net supplies it.`,
      hint: "Connect this net to a power source or a regulator output, or mark the net as a power rail if the supply is off-sheet.",
      elementIds: consumers.map((p) => p.source_port_id),
      where,
    })
  }

  return violations
}

/** A design with no ground is not a circuit; it is a drawing. */
const noGroundReference: Rule = ({ view }) => {
  if (view.components.size === 0) return []

  const hasGroundNet = [...view.nets.values()].some(
    (net) =>
      Boolean((net as unknown as Record<string, unknown>)["is_ground"]) ||
      /^(gnd|ground|vss|agnd|dgnd)$/i.test(net.name),
  )
  const hasGroundComponent = [...view.components.values()].some((c) => c.ftype === "simple_ground")
  const hasGroundPin = [...view.ports.values()].some((p) => p.provides_ground)

  if (hasGroundNet || hasGroundComponent || hasGroundPin) return []

  return [
    {
      rule: "no_ground_reference",
      severity: "error",
      message: "The design has no ground reference.",
      hint: "Add a ground symbol or a net named GND and connect the circuit's return path to it. Simulation cannot solve a circuit without a reference node.",
      elementIds: [],
    },
  ]
}

/**
 * A component whose value was never set.
 *
 * Core defaults an omitted passive value to 0 so the document stays conformant; the
 * absence of the matching `display_*` field is what distinguishes "never set" from a
 * deliberate 0 Ω link.
 */
const missingValue: Rule = ({ view }) => {
  const violations: ErcViolation[] = []

  for (const component of view.components.values()) {
    const spec = ftypeSpec(component.ftype ?? "")
    if (!spec?.valueProp) continue

    const record = component as unknown as Record<string, unknown>
    const numeric = record[spec.valueProp]
    const display = record[`display_${spec.valueProp}`]

    if (numeric !== 0 || display !== undefined) continue

    violations.push({
      rule: "missing_value",
      severity: "warning",
      message: `${component.name} has no ${spec.valueProp} set.`,
      hint: `Set it with set_prop, for example { component: "${component.name}", key: "${spec.valueProp}", value: "10k" }. If a 0 Ω link is intended, set it explicitly.`,
      elementIds: [component.source_component_id],
      where: component.name,
    })
  }

  return violations
}

/** Two components sharing a refdes. */
const duplicateRefdes: Rule = ({ view }) => {
  const seen = new Map<string, string[]>()
  for (const component of view.components.values()) {
    const list = seen.get(component.name) ?? []
    list.push(component.source_component_id)
    seen.set(component.name, list)
  }

  return [...seen.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([name, ids]) => ({
      rule: "duplicate_refdes" as ErcRuleId,
      severity: "error" as const,
      message: `${ids.length} components share the refdes "${name}".`,
      hint: `Rename all but one of them. A duplicated designator makes the BOM and the board assembly ambiguous.`,
      elementIds: ids,
      where: name,
    }))
}

/** A trace referencing a port that is not in the document. */
const unknownPartPin: Rule = ({ view }) => {
  const violations: ErcViolation[] = []

  for (const trace of view.traces.values()) {
    for (const portId of trace.connected_source_port_ids ?? []) {
      if (view.ports.has(portId)) continue
      violations.push({
        rule: "unknown_part_pin",
        severity: "error",
        message: `A trace references port "${portId}", which does not exist in the design.`,
        hint: "This usually means a component was removed without pruning its traces. Remove the trace, or re-add the missing component.",
        elementIds: [trace.source_trace_id, portId],
      })
    }
  }

  return violations
}

const RULES: Record<ErcRuleId, Rule> = {
  dangling_pin: danglingPin,
  single_pin_net: singlePinNet,
  output_output_short: outputOutputShort,
  power_in_without_driver: powerInWithoutDriver,
  no_ground_reference: noGroundReference,
  missing_value: missingValue,
  duplicate_refdes: duplicateRefdes,
  unknown_part_pin: unknownPartPin,
}

/**
 * Run every enabled rule.
 *
 * Never throws: ERC on a malformed design must still return a report, because "your
 * design is broken" is exactly when the caller most needs to hear the details.
 */
export const runErc = (design: Design, options: ErcOptions = {}): ErcReport => {
  const view = buildIndex(design.circuit)
  const ctx: RuleContext = { design, view }
  const disabled = new Set(options.disabledRules ?? [])

  const violations: ErcViolation[] = []
  for (const [id, rule] of Object.entries(RULES) as Array<[ErcRuleId, Rule]>) {
    if (disabled.has(id)) continue
    try {
      violations.push(...rule(ctx))
    } catch (cause) {
      violations.push({
        rule: id,
        severity: "warning",
        message: `The ${id} rule failed to run: ${cause instanceof Error ? cause.message : String(cause)}`,
        hint: "This is a bug in SYNTRIX, not a problem with the design. The other rules still ran.",
        elementIds: [],
      })
    }
  }

  // Strict mode promotes warnings, but never `info` — informational leads are not
  // defects, and turning them into build failures would make strict mode unusable.
  const effective = options.strict
    ? violations.map((v) => (v.severity === "warning" ? { ...v, severity: "error" as const } : v))
    : violations

  const errorCount = effective.filter((v) => v.severity === "error").length
  const warningCount = effective.filter((v) => v.severity === "warning").length

  return {
    violations: effective,
    errorCount,
    warningCount,
    pass: errorCount === 0,
    ranAt: new Date().toISOString(),
  }
}

/** A compact rendering for the agent, which gets the report as text in its context. */
export const formatErcForLlm = (report: ErcReport, maxViolations = 25): string => {
  if (report.violations.length === 0) return "ERC passed with no violations."

  // A report carrying only informational leads is still a pass, and must read as one —
  // otherwise the agent treats notes as failures and loops trying to "fix" them.
  const headline =
    report.errorCount === 0 && report.warningCount === 0
      ? "ERC passed. Informational notes:"
      : `ERC: ${report.errorCount} error(s), ${report.warningCount} warning(s).`

  const lines = [
    headline,
    ...report.violations
      .slice(0, maxViolations)
      .map((v) => `- [${v.severity}] ${v.rule}: ${v.message} → ${v.hint}`),
  ]

  if (report.violations.length > maxViolations) {
    lines.push(`- … and ${report.violations.length - maxViolations} more.`)
  }

  return lines.join("\n")
}

export { connectedPorts }
