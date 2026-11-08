/**
 * pi model catalog for the DSH LLM registry.
 *
 * The browser's model selector reads `ctx.llm.listProviders()` / `listModels()`.
 * For a pi-driven deployment the truthful catalog is what the `pi` child can
 * actually run, so this adapter advertises exactly the models `pi` reports via
 * `get_available_models`. Route names are pi's own (`deepseek/deepseek-flash`),
 * which keeps selection a straight pass-through instead of a mapping.
 *
 * The adapter never executes a call: pi owns inference. Anything that reaches
 * `stream()` on this route belongs to a DSH-side feature that should be
 * disabled (or routed elsewhere) in a pi profile.
 */

import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { PiRpcClient } from './rpc.js'

const EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** Ask one short-lived pi child which models it can run. */
export async function probeModels({ piPath, cwd, logger, timeoutMs = 20000 }) {
  const rpc = new PiRpcClient({ piPath, cwd, logger })
  try {
    const response = await Promise.race([
      rpc.send({ type: 'get_available_models' }),
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error(`pi get_available_models timed out after ${String(timeoutMs)}ms`)), timeoutMs)
        timer.unref?.()
      }),
    ])
    if (response.success !== true) throw new Error(response.error ?? 'pi get_available_models failed')
    const models = response.data?.models
    return Array.isArray(models) ? models : []
  } finally {
    rpc.close()
  }
}

/** Map pi's thinking-level map onto DSH's ordered effort list. */
function reasoningOf(model) {
  const map = model.thinkingLevelMap
  if (model.reasoning !== true || map === undefined || map === null) return undefined
  const efforts = EFFORT_ORDER.filter((level) => map[level] !== undefined && map[level] !== null)
    .map((level) => ({ id: level, name: level }))
  return efforts.length === 0 ? undefined : { efforts }
}

/** One catalog-only adapter covering every provider route pi reported. */
export class PiCatalogAdapter extends LlmAdapter {
  constructor(models) {
    super()
    this.byProvider = new Map()
    for (const model of models) {
      const provider = String(model.provider ?? '')
      if (provider === '' || typeof model.id !== 'string') continue
      const bucket = this.byProvider.get(provider) ?? []
      bucket.push(model)
      this.byProvider.set(provider, bucket)
    }
    this.providers = [...this.byProvider.keys()]
  }

  providerInfo(provider) {
    return { id: provider, name: `pi · ${provider}` }
  }

  /** Route facts recorded on `request/context` (context window when advertised). */
  lookup(provider, model) {
    const entry = (this.byProvider.get(provider) ?? []).find((candidate) => candidate.id === model)
    if (entry === undefined) return undefined
    return {
      ...(typeof entry.contextWindow === 'number' ? { contextWindow: entry.contextWindow } : {}),
    }
  }

  async listModels(provider) {
    return (this.byProvider.get(provider) ?? []).map((model) => ({
      provider,
      id: model.id,
      name: typeof model.name === 'string' && model.name !== '' ? model.name : model.id,
      ...(model.input === undefined ? {} : { inputModalities: model.input }),
    }))
  }

  async resolveModel(provider, model) {
    const entry = (this.byProvider.get(provider) ?? []).find((candidate) => candidate.id === model)
    if (entry === undefined) throw new Error(`pi does not advertise model "${provider}/${model}"`)
    const reasoning = reasoningOf(entry)
    return {
      provider,
      id: entry.id,
      name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : entry.id,
      ...(typeof entry.contextWindow === 'number' ? { context: { contextWindow: entry.contextWindow } } : {}),
      ...(typeof entry.maxTokens === 'number' ? { defaultMaxTokens: entry.maxTokens } : {}),
      ...(reasoning === undefined ? {} : { reasoning }),
    }
  }

  // eslint-disable-next-line require-yield
  async *stream() {
    throw new Error('dsh-pi-agent: pi executes model calls; the DSH catalog route is display-only')
  }
}
