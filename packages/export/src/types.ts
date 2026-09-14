/**
 * Exporter plugin contract.
 *
 * Registering an exporter never touches core. An exporter receives the design and
 * returns artifacts; it does not mutate, and it does not reach into the sidecar for
 * anything but read-only metadata.
 */

import type { Design } from "@syntrix/core"
import type { Result, ValidationError } from "@syntrix/shared"

export interface Artifact {
  /** Filename including extension, e.g. "rc_lowpass.kicad_sch". */
  filename: string
  mime: string
  /** Text artifacts carry `text`; binary ones carry `bytes`. Exactly one is set. */
  text?: string
  bytes?: Uint8Array
}

export interface ExportContext {
  /** Resolve SPICE models, footprints and pin maps without importing @syntrix/parts. */
  resolvePart?: (partRef: string) => Promise<unknown>
  /** Exporter-specific options, validated by the exporter itself. */
  options?: Record<string, unknown>
}

export interface Exporter {
  id: string
  label: string
  /** Primary extension, without the dot. */
  ext: string
  mime: string
  /** Milestone that introduces this exporter, for capability reporting. */
  since?: string
  export(design: Design, ctx?: ExportContext): Promise<Result<Artifact[], ValidationError[]>>
}

export interface ExporterRegistry {
  register(exporter: Exporter): void
  get(id: string): Exporter | undefined
  list(): Exporter[]
}
