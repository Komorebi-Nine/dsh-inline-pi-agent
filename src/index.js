/**
 * dsh-pi-agent — run the pi coding agent loop inside DeepSeek Harness.
 *
 * Registers an `AgentFactory`, so every session the frontend creates is driven
 * by a headless `pi --mode rpc` child instead of `dsh-agent-loop`. Disable the
 * `agent-loop` profile row before mounting this plugin: the registry allows a
 * single factory and throws when one is already registered.
 *
 * Disabling `agent-loop` also removes the `inbox` / `modelSelection` session
 * projections it owns, so this plugin registers them itself.
 */

import { PiCatalogAdapter, probeModels } from './catalog.js'
import { PiAgentFactory } from './factory.js'
import { projectionDefinitions } from './projections.js'

export const name = 'pi-agent'

export const inject = ['sessions', 'agents', 'sessionProjections', 'llm']

export async function apply(ctx, config = {}) {
  // `agent-loop` normally owns these units. During a live bundle toggle the two
  // owners can overlap; a duplicate registration must not fail this plugin (or
  // worse, fail the reloading tree) — the other owner provides the same fold.
  for (const definition of projectionDefinitions) {
    try {
      await ctx.sessionProjections.register(definition)
    } catch (error) {
      ctx.logger?.warn?.(`[pi-agent] projection "${String(definition.key)}" already owned: ${String(error)}`)
    }
  }

  const debug = config.debug === true
  const logger = debug
    ? (line) => {
        try {
          ctx.logger?.debug?.(line)
        } catch {
          // diagnostics must never break the plugin
        }
      }
    : undefined

  // Advertise pi's own models so the selector offers what actually runs.
  // Registered before the factory so a published agent implies a ready catalog.
  let modelInfo
  if (config.catalog !== false) {
    try {
      const models = await probeModels({ piPath: config.piPath ?? 'pi', cwd: config.cwd ?? process.cwd(), logger })
      const adapter = new PiCatalogAdapter(models)
      if (adapter.providers.length > 0) {
        ctx.llm.registerAdapter(adapter.providers, adapter)
        modelInfo = (provider, model) => adapter.lookup(provider, model)
      }
    } catch (error) {
      ctx.logger?.warn?.(`[pi-agent] model catalog unavailable: ${String(error)}`)
    }
  }

  const factory = new PiAgentFactory(ctx, {
    piPath: config.piPath ?? 'pi',
    cwd: config.cwd ?? process.cwd(),
    model: config.model ?? '',
    ...(config.models === undefined ? {} : { models: config.models }),
    ...(config.piSessionDir === undefined ? {} : { piSessionDir: config.piSessionDir }),
    requestHeader: config.requestHeader !== false,
    ...(modelInfo === undefined ? {} : { modelInfo }),
    logger,
  })
  ctx.agents.setFactory(factory)

  // A live bundle toggle unloads this plugin while agents may still be running:
  // tear them down (and close their pi children) instead of leaking them.
  ctx.effect(() => () => factory.disposeAll())
}
