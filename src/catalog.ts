/**
 * `session/modelCatalog` response enrichment: the host's 0.1.2 catalog lists
 * models without their input modalities, so the mobile app cannot tell a
 * vision model from a text-only one and image sends fail only at prompt time
 * ("does not support image input"). The gateway asks the host's own LLM
 * runtime in-process (`resolveModelInfo` — the same call the prompt gate and
 * the host's catalog builder make) and annotates each model entry with
 * `inputModalities`, using the host's exact semantics: absent = unknown and
 * the host does not restrict; declared without `image` = image sends will be
 * refused.
 *
 * Fail-open everywhere: a shape change, a throwing model resolution, or an
 * absent llm runtime must degrade to the original body, never to a broken
 * catalog.
 * @module
 */

import type { LlmRuntime } from '@deepseek-ai/dsh-llm'

/** Capability inputs the enricher reads per request. */
export interface CatalogCapabilitySource {
  /** The host LLM runtime; undefined when the injection has not resolved. */
  llm?: LlmRuntime
  /**
   * Model ids to mark image-capable when discovery cannot (runtime absent or
   * the model declares no modalities). Deployment-owned escape hatch.
   */
  visionModels(): readonly string[]
}

/** Rewrite one catalog response body; returns the input unchanged on any doubt. */
export type CatalogEnricher = (bodyText: string) => Promise<string>

/** One model entry the host catalog carries (only the fields we touch). */
interface CatalogModelEntry {
  id?: unknown
  inputModalities?: unknown
  [key: string]: unknown
}

/** Locate the catalog payload: bare, or inside the unary RPC envelope (`result.value`). */
function findCatalog(payload: unknown): Record<string, unknown> | null {
  if (typeof payload !== 'object' || payload === null) return null
  if (Array.isArray((payload as Record<string, unknown>).groups)) return payload as Record<string, unknown>
  const result = (payload as Record<string, unknown>).result
  if (typeof result !== 'object' || result === null) return null
  const value = (result as Record<string, unknown>).value
  if (typeof value === 'object' && value !== null && Array.isArray((value as Record<string, unknown>).groups)) {
    return value as Record<string, unknown>
  }
  return null
}

/**
 * Build the enricher bound to the live capability source. Every call parses
 * the body, annotates entries that carry no `inputModalities` yet, and
 * re-serializes; host-native fields always win and are never rewritten.
 */
export function createCatalogEnricher(source: CatalogCapabilitySource): CatalogEnricher {
  return async function enrichModelCatalog(bodyText: string): Promise<string> {
    let payload: unknown
    try {
      payload = JSON.parse(bodyText)
    } catch {
      return bodyText
    }
    const catalog = findCatalog(payload)
    if (catalog === null) return bodyText
    const vision = new Set(source.visionModels())
    for (const group of catalog.groups as unknown[]) {
      if (typeof group !== 'object' || group === null) continue
      const providerId = (group as Record<string, unknown>).id
      const models = (group as Record<string, unknown>).models
      if (typeof providerId !== 'string' || !Array.isArray(models)) continue
      await Promise.all(models.map(async (entry) => {
        if (typeof entry !== 'object' || entry === null) return
        const model = entry as CatalogModelEntry
        if (model.inputModalities !== undefined) return
        const modalities = await resolveModalities(source.llm, providerId, String(model.id ?? ''), vision)
        if (modalities !== undefined) model.inputModalities = modalities
      }))
    }
    return JSON.stringify(payload)
  }
}

/**
 * One model's modalities: the runtime's own declaration, else the config
 * escape hatch, else undefined (unknown — no field is emitted).
 */
async function resolveModalities(
  llm: LlmRuntime | undefined,
  providerId: string,
  modelId: string,
  vision: ReadonlySet<string>,
): Promise<readonly string[] | undefined> {
  if (llm !== undefined && modelId !== '') {
    try {
      const info = await llm.resolveModelInfo(providerId, modelId)
      if (info?.inputModalities !== undefined) return [...info.inputModalities]
    } catch {
      // Unknown model / adapter refusal: fall through to config, then unknown.
    }
  }
  return vision.has(modelId) ? ['text', 'image'] : undefined
}
