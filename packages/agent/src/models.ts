/**
 * Role → model routing.
 *
 * Principle 8: switching provider is an edit to `config/models.yaml` plus the matching
 * key in the environment, and nothing else. This module is the only place that knows a
 * provider package exists; everything above it asks for a role.
 *
 * Resolution order for a role is env var, then the yaml, then `defaults` — so an operator
 * can try a different model for one run without editing a file that is under version
 * control, which is the actual reason people hardcode models.
 */

import { readFileSync } from "node:fs"
import type { AgentRole, ModelRouting } from "./types"

export type ProviderId = "openrouter" | "anthropic" | "openai" | "google" | "ollama"

export interface ProviderConfig {
  package: string
  apiKeyEnv?: string
  baseUrlEnv?: string
  defaultBaseUrl?: string
}

export interface ModelsConfig {
  defaults: { provider: ProviderId; temperature?: number; maxTokens?: number }
  roles: Record<string, Partial<ModelRouting> & { model?: string }>
  providers: Record<string, ProviderConfig>
  limits: { maxIterations: number; maxToolCallsPerIteration: number; maxCostUsdPerRun: number }
}

export interface ProviderStatus {
  id: ProviderId
  available: boolean
  /** Why not, so a missing key is diagnosable from the UI rather than from a stack trace. */
  detail?: string
}

/**
 * A deliberately small YAML reader.
 *
 * `config/models.yaml` is a flat map of scalars two or three levels deep, with no
 * anchors, lists or multi-line strings. Parsing that is thirty lines; taking a YAML
 * dependency into every package that reads a config file is not obviously better, and
 * this fails loudly on anything it does not understand rather than guessing.
 */
export const parseSimpleYaml = (source: string): Record<string, unknown> => {
  const root: Record<string, unknown> = {}
  // Each entry is the container for one indentation level.
  const stack: Array<{ indent: number; node: Record<string, unknown> }> = [
    { indent: -1, node: root },
  ]

  for (const raw of source.split(/\r?\n/)) {
    const withoutComment = raw.replace(/(^|\s)#.*$/, "")
    if (withoutComment.trim().length === 0) continue

    const indent = withoutComment.length - withoutComment.trimStart().length
    const line = withoutComment.trim()
    const colon = line.indexOf(":")
    if (colon < 0) continue

    const key = line.slice(0, colon).trim()
    const value = line.slice(colon + 1).trim()

    while (stack.length > 1 && indent <= stack[stack.length - 1]!.indent) stack.pop()
    const parent = stack[stack.length - 1]!.node

    if (value.length === 0) {
      const child: Record<string, unknown> = {}
      parent[key] = child
      stack.push({ indent, node: child })
      continue
    }

    parent[key] = coerce(value)
  }

  return root
}

const coerce = (value: string): string | number | boolean => {
  const unquoted = value.replace(/^["'](.*)["']$/, "$1")
  if (unquoted === "true") return true
  if (unquoted === "false") return false
  if (unquoted !== "" && !Number.isNaN(Number(unquoted))) return Number(unquoted)
  return unquoted
}

export const loadModelsConfig = (path: string): ModelsConfig => {
  const parsed = parseSimpleYaml(readFileSync(path, "utf8")) as unknown as ModelsConfig
  if (!parsed.roles || !parsed.providers) {
    throw new Error(`${path}: missing "roles" or "providers"`)
  }
  return parsed
}

/**
 * The model for a role.
 *
 * `SYNTRIX_MODEL_PLANNER=anthropic/claude-opus-4.5` overrides the yaml. The value may
 * name a provider (`anthropic:claude-...`) or rely on the role's configured one, which is
 * what makes "try this one model somewhere else" a single environment variable.
 */
export const resolveRouting = (
  config: ModelsConfig,
  role: AgentRole,
  env: NodeJS.ProcessEnv = process.env,
): ModelRouting => {
  const configured = config.roles[role] ?? {}
  const override = env[`SYNTRIX_MODEL_${role.toUpperCase()}`]

  let provider = (configured.provider ?? config.defaults?.provider ?? "openrouter") as ProviderId
  let model = configured.model ?? ""

  if (override) {
    const separator = override.indexOf(":")
    if (separator > 0) {
      provider = override.slice(0, separator) as ProviderId
      model = override.slice(separator + 1)
    } else {
      model = override
    }
  }

  if (!model) throw new Error(`No model configured for role "${role}".`)

  return {
    role,
    provider,
    model,
    temperature: configured.temperature ?? config.defaults?.temperature ?? 0.2,
    maxTokens: configured.maxTokens ?? config.defaults?.maxTokens ?? 4096,
  }
}

/**
 * Whether a provider can actually be used.
 *
 * Checked before a run rather than discovered during one: an agent that gets four tool
 * calls in and then fails on a missing key has wasted the user's time and some money.
 * Ollama needs no key, which is the whole point of running it locally.
 */
export const providerStatus = (
  config: ModelsConfig,
  provider: ProviderId,
  env: NodeJS.ProcessEnv = process.env,
): ProviderStatus => {
  const entry = config.providers[provider]
  if (!entry) return { id: provider, available: false, detail: "not configured in models.yaml" }

  if (provider === "ollama") {
    const baseUrl = (entry.baseUrlEnv ? env[entry.baseUrlEnv] : undefined) ?? entry.defaultBaseUrl
    return baseUrl
      ? { id: provider, available: true }
      : { id: provider, available: false, detail: "no base URL configured" }
  }

  if (!entry.apiKeyEnv) return { id: provider, available: false, detail: "no API key variable" }

  return env[entry.apiKeyEnv]
    ? { id: provider, available: true }
    : { id: provider, available: false, detail: `${entry.apiKeyEnv} is not set` }
}

/**
 * Build a Vercel AI SDK model for a routing.
 *
 * The provider packages are imported lazily and by name from the config, so a deployment
 * that only ever uses OpenRouter never loads the other four — and adding a provider is a
 * yaml entry plus a dependency, with no branch to add here.
 *
 * Returns the SDK's `LanguageModel`, typed loosely on purpose: pinning it would couple
 * every caller to one `ai` major version, and this module exists precisely so they do not
 * have to care.
 */
export const createModel = async (
  config: ModelsConfig,
  routing: ModelRouting,
  env: NodeJS.ProcessEnv = process.env,
): Promise<unknown> => {
  const entry = config.providers[routing.provider]
  if (!entry) throw new Error(`Provider "${routing.provider}" is not in models.yaml.`)

  const status = providerStatus(config, routing.provider, env)
  if (!status.available) {
    throw new Error(`Provider "${routing.provider}" is unavailable: ${status.detail}`)
  }

  const module_ = (await import(/* @vite-ignore */ entry.package)) as Record<string, unknown>

  // Every AI SDK provider package exports both a ready-made default instance and a
  // `createX` factory. The factory is used so the base URL and key come from our config
  // rather than from whatever the package reads out of the environment itself.
  const factory = Object.entries(module_).find(
    ([name, value]) => /^create[A-Z]/.test(name) && typeof value === "function",
  )?.[1] as ((options: Record<string, unknown>) => (model: string) => unknown) | undefined

  if (!factory) {
    // Fall back to the default export, which is callable with a model id.
    const direct = (module_["default"] ?? module_[routing.provider]) as
      ((model: string) => unknown) | undefined
    if (typeof direct !== "function") {
      throw new Error(`${entry.package} exports neither a createX factory nor a callable default.`)
    }
    return direct(routing.model)
  }

  const options: Record<string, unknown> = {}
  if (entry.apiKeyEnv && env[entry.apiKeyEnv]) options["apiKey"] = env[entry.apiKeyEnv]
  const baseUrl = (entry.baseUrlEnv ? env[entry.baseUrlEnv] : undefined) ?? entry.defaultBaseUrl
  if (baseUrl) options["baseURL"] = baseUrl

  return factory(options)(routing.model)
}
