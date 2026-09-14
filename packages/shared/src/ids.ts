/**
 * Id generation.
 *
 * Ids are created here and nowhere else, so tests can make them deterministic. Inline
 * `Math.random()` would make every snapshot test unstable and every golden fixture
 * unreproducible.
 */

/** A source of ids. Swap it in tests; leave it alone in production. */
export interface IdFactory {
  next(prefix: string): string
  reset(): void
}

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz"

/**
 * Production factory: a monotonic counter plus randomness. The counter guarantees
 * uniqueness within a process; the random suffix avoids collisions when two processes
 * write to the same design.
 */
export const createRandomIdFactory = (): IdFactory => {
  let counter = 0
  return {
    next(prefix) {
      counter += 1
      let suffix = ""
      for (let i = 0; i < 6; i += 1) {
        suffix += ALPHABET[Math.floor(Math.random() * ALPHABET.length)]
      }
      return `${prefix}_${counter.toString(36)}${suffix}`
    },
    reset() {
      counter = 0
    },
  }
}

/**
 * Deterministic factory for tests and golden fixtures: `source_component_1`,
 * `source_component_2`, and so on, counted per prefix.
 */
export const createSequentialIdFactory = (): IdFactory => {
  const counters = new Map<string, number>()
  return {
    next(prefix) {
      const n = (counters.get(prefix) ?? 0) + 1
      counters.set(prefix, n)
      return `${prefix}_${n}`
    },
    reset() {
      counters.clear()
    },
  }
}

let activeFactory: IdFactory = createRandomIdFactory()

/** Generate an id with the active factory. */
export const newId = (prefix: string): string => activeFactory.next(prefix)

/** Swap the active factory. Tests call this with a sequential factory in `beforeEach`. */
export const setIdFactory = (factory: IdFactory): void => {
  activeFactory = factory
}

export const getIdFactory = (): IdFactory => activeFactory

/**
 * circuit-json names its id fields after the element type (`source_component_id` on a
 * `source_component`), so the prefix is the type itself and ids read as
 * `source_component_1`.
 */
export const newElementId = (elementType: string): string => newId(elementType)

/**
 * Refdes assignment.
 *
 * The prefix follows schematic convention, not the ftype name: a `simple_resistor` is
 * R1, not SR1. Anything unrecognised falls back to U, the generic IC prefix.
 */
const REFDES_PREFIXES: Record<string, string> = {
  simple_resistor: "R",
  simple_capacitor: "C",
  simple_inductor: "L",
  simple_diode: "D",
  simple_led: "D",
  simple_transistor: "Q",
  simple_mosfet: "Q",
  simple_chip: "U",
  simple_op_amp: "U",
  simple_crystal: "Y",
  simple_resonator: "Y",
  simple_fuse: "F",
  simple_switch: "SW",
  simple_push_button: "SW",
  simple_potentiometer: "RV",
  simple_pin_header: "J",
  simple_connector: "J",
  simple_battery: "BT",
  simple_power_source: "V",
  simple_voltage_source: "V",
  simple_current_source: "I",
  simple_ground: "GND",
  simple_test_point: "TP",
  simple_fiducial: "FID",
  simple_ammeter: "A",
  simple_voltage_probe: "VP",
}

export const refdesPrefixFor = (ftype: string): string => REFDES_PREFIXES[ftype] ?? "U"

/**
 * Next free refdes for an ftype, given the names already in use. Gaps are filled: after
 * deleting R2 from R1/R2/R3, the next resistor is R2, not R4 — which matches how every
 * schematic editor behaves and keeps designations dense.
 */
export const nextRefdes = (ftype: string, existingNames: Iterable<string>): string => {
  const prefix = refdesPrefixFor(ftype)
  const used = new Set<number>()
  const pattern = new RegExp(`^${prefix}(\\d+)$`)

  for (const name of existingNames) {
    const match = pattern.exec(name)
    if (match?.[1]) used.add(Number(match[1]))
  }

  let n = 1
  while (used.has(n)) n += 1
  return `${prefix}${n}`
}

/**
 * A factory that records what it generated, and one that plays it back.
 *
 * This is what makes event sourcing work. `apply` mints ids as it goes, so replaying an
 * operation log with a fresh factory produces a design that is structurally identical and
 * yet has different element ids — which orphans everything keyed by id (the `meta`
 * sidecar), and invalidates any id a client is holding. Undo would silently break both.
 *
 * So the log records the ids each operation minted, and replay hands them back in the
 * same order. Replay then reproduces the original design exactly rather than merely
 * equivalently.
 *
 * `recordIds` returns the ids in generation order; feed them to `createReplayIdFactory`.
 * If a replay asks for more ids than were recorded — which means the reducer changed
 * since the entry was written — the factory falls through to fresh ones rather than
 * throwing, so an engine upgrade degrades to "ids moved" instead of "design unopenable".
 */
export const createRecordingIdFactory = (
  inner: IdFactory = createRandomIdFactory(),
): IdFactory & { recorded(): string[] } => {
  const recorded: string[] = []
  return {
    next(prefix) {
      const id = inner.next(prefix)
      recorded.push(id)
      return id
    },
    reset() {
      inner.reset()
      recorded.length = 0
    },
    recorded: () => [...recorded],
  }
}

export const createReplayIdFactory = (
  ids: readonly string[],
  fallback: IdFactory = createRandomIdFactory(),
): IdFactory => {
  let cursor = 0
  return {
    next(prefix) {
      const recorded = ids[cursor]
      cursor += 1
      return recorded ?? fallback.next(prefix)
    },
    reset() {
      cursor = 0
      fallback.reset()
    },
  }
}

/** Run `work` with `factory` installed, restoring whatever was active before. */
export const withIdFactory = <T>(factory: IdFactory, work: () => T): T => {
  const previous = getIdFactory()
  setIdFactory(factory)
  try {
    return work()
  } finally {
    setIdFactory(previous)
  }
}
