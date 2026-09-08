/// Catalog enrichment: model entries gain `inputModalities` from the host LLM
/// runtime's own declarations; the config escape hatch fills only what
/// discovery cannot; host-native fields pass through untouched; every failure
/// mode degrades to the original body.
import { describe, expect, it } from 'vitest'
import { createCatalogEnricher, type CatalogCapabilitySource } from '../src/catalog.ts'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'

const BODY = JSON.stringify({
  type: 'server-response',
  rpcId: 'r1',
  result: { ok: true, value: {
  default: { provider: 'p1', model: 'm-text' },
  routableProviders: ['p1'],
  groups: [
    {
      id: 'p1',
      name: 'Provider One',
      models: [
        { id: 'm-text', name: 'Text Model' },
        { id: 'm-vision', name: 'Vision Model' },
        { id: 'm-config', name: 'Config Model' },
        { id: 'm-native', name: 'Native Model', inputModalities: ['text', 'audio'] },
      ],
    },
  ],
  failures: [],
} } })

function runtime(overrides: Record<string, { inputModalities?: readonly string[] } | Error>): LlmRuntime {
  return {
    resolveModelInfo: async (provider: string, model: string) => {
      const hit = overrides[`${provider}/${model}`]
      if (hit instanceof Error) throw hit
      return hit as Awaited<ReturnType<LlmRuntime['resolveModelInfo']>>
    },
  } as unknown as LlmRuntime
}

function source(llm?: LlmRuntime, visionModels: string[] = []): CatalogCapabilitySource {
  return { llm, visionModels: () => visionModels }
}

/** The enricher edits the wire envelope; assertions read the catalog inside. */
function parseCatalog(text: string): { groups: Array<{ models: Array<Record<string, unknown>> }> } {
  const envelope = JSON.parse(text) as { result: { value: { groups: Array<{ models: Array<Record<string, unknown>> }> } } }
  return envelope.result.value
}

describe('createCatalogEnricher', () => {
  it('annotates entries from the runtime declarations, keeps native fields', async () => {
    const enrich = createCatalogEnricher(source(runtime({
      'p1/m-text': { inputModalities: ['text'] },
      'p1/m-vision': { inputModalities: ['text', 'image'] },
      // m-config: no declaration → unknown
    })))

    const out = parseCatalog(await enrich(BODY))
    const models = Object.fromEntries(out.groups[0]!.models.map(m => [m.id, m]))
    expect(models['m-text']!.inputModalities).toEqual(['text'])
    expect(models['m-vision']!.inputModalities).toEqual(['text', 'image'])
    expect(models['m-config']).not.toHaveProperty('inputModalities')
    // Host-native values win and are never rewritten.
    expect(models['m-native']!.inputModalities).toEqual(['text', 'audio'])
  })

  it('fills undeclared ids from the visionModels escape hatch', async () => {
    const enrich = createCatalogEnricher(source(runtime({}), ['m-config']))
    const out = parseCatalog(await enrich(BODY))
    const models = Object.fromEntries(out.groups[0]!.models.map(m => [m.id, m]))
    expect(models['m-config']!.inputModalities).toEqual(['text', 'image'])
    expect(models['m-text']).not.toHaveProperty('inputModalities')
  })

  it('treats a throwing runtime like an absent one: degrade, never fail', async () => {
    const throwing = runtime({
      'p1/m-text': new Error('adapter exploded'),
      'p1/m-vision': new Error('adapter exploded'),
    })
    const enrich = createCatalogEnricher(source(throwing, ['m-vision']))
    const out = parseCatalog(await enrich(BODY))
    const models = Object.fromEntries(out.groups[0]!.models.map(m => [m.id, m]))
    expect(models['m-text']).not.toHaveProperty('inputModalities')
    expect(models['m-vision']!.inputModalities).toEqual(['text', 'image'])
  })

  it('returns non-JSON and wrong-shaped bodies unchanged', async () => {
    const enrich = createCatalogEnricher(source(runtime({})))
    expect(await enrich('not json at all')).toBe('not json at all')
    expect(await enrich(JSON.stringify({ unexpected: true }))).toBe(JSON.stringify({ unexpected: true }))
    expect(await enrich(JSON.stringify({ type: 'server-response', result: { ok: false, error: {} } })))
      .toBe(JSON.stringify({ type: 'server-response', result: { ok: false, error: {} } }))
  })

  it('works without a runtime (config escape hatch only)', async () => {
    const enrich = createCatalogEnricher(source(undefined, ['m-vision']))
    const out = parseCatalog(await enrich(BODY))
    const models = Object.fromEntries(out.groups[0]!.models.map(m => [m.id, m]))
    expect(models['m-vision']!.inputModalities).toEqual(['text', 'image'])
    expect(models['m-text']).not.toHaveProperty('inputModalities')
  })
})
