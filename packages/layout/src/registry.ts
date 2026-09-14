/** Layout strategy registry. Adding a strategy never touches core. */

import type { LayoutStrategy, LayoutStrategyRegistry } from "./types"
import { elkLayoutStrategy } from "./elk-strategy"

export const createLayoutRegistry = (): LayoutStrategyRegistry => {
  const strategies = new Map<string, LayoutStrategy>()
  return {
    register: (strategy) => void strategies.set(strategy.id, strategy),
    get: (id) => strategies.get(id),
    list: () => [...strategies.values()],
  }
}

/** A registry with ELK registered — the default for any app that has not configured more. */
export const createDefaultLayoutRegistry = (): LayoutStrategyRegistry => {
  const registry = createLayoutRegistry()
  registry.register(elkLayoutStrategy)
  return registry
}
