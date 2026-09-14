/**
 * The exporter registry.
 *
 * One pattern, as everywhere else: an interface, a map keyed by id, and registration at
 * startup. Adding an exporter never touches core and never touches this file's logic.
 */

import type { Exporter, ExporterRegistry } from "./types"

export const createExporterRegistry = (initial: Exporter[] = []): ExporterRegistry => {
  const exporters = new Map<string, Exporter>()
  for (const exporter of initial) exporters.set(exporter.id, exporter)

  return {
    register(exporter) {
      exporters.set(exporter.id, exporter)
    },
    get(id) {
      return exporters.get(id)
    },
    list() {
      return [...exporters.values()].sort((a, b) => a.label.localeCompare(b.label))
    },
  }
}
