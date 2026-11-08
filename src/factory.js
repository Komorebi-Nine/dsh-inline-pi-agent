/**
 * PiAgentFactory — the `AgentFactory` behind `ctx.agents.create/resume`.
 *
 * Mirrors dsh-agent-loop's ordered transaction: prepare the session, take the
 * durable write handle, store the unstored suffix, enter and announce the
 * session, run the caller's setup while the agent is unpublished, then enter
 * and announce the agent. Teardown walks the same chain in reverse.
 */

import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { emitAgentEvent } from '@deepseek-ai/dsh-agent'
import { SessionLogOffset, interruptedTurnClosers } from '@deepseek-ai/dsh-session'
import { PiAgent } from './agent.js'
import { buildPiSessionFile } from './history.js'
import { PiRpcClient } from './rpc.js'

/** Split the configured `provider/model` route into agent options. */
function routeOptions(route) {
  if (typeof route !== 'string' || route === '') return {}
  const separator = route.indexOf('/')
  if (separator === -1) return { model: route }
  return { provider: route.slice(0, separator), model: route.slice(separator + 1) }
}

/** Split a pi route string into the `set_model` fields. */
function splitRoute(route) {
  const separator = route.indexOf('/')
  if (separator === -1) return undefined
  return { provider: route.slice(0, separator), modelId: route.slice(separator + 1) }
}

export class PiAgentFactory {
  constructor(registryCtx, options) {
    this.registryCtx = registryCtx
    this.options = options
    this.live = new Set()
  }

  /** Stop every agent this factory published (plugin unload). */
  disposeAll() {
    const disposers = [...this.live]
    this.live.clear()
    return Promise.allSettled(disposers.map((dispose) => dispose()))
  }

  #sessionFile(id) {
    const directory = this.options.piSessionDir ?? join(homedir(), '.dsh', 'pi-sessions')
    mkdirSync(directory, { recursive: true })
    return join(directory, `${String(id).replace(/[^\w-]/g, '_')}.jsonl`)
  }

  /** Take write ownership when a persistence backend is mounted. */
  async #createStored(session, signal) {
    const persistence = this.registryCtx.get('sessionPersistence')
    if (persistence === undefined) return undefined
    if (signal?.aborted === true) throw new Error(`agent "${String(session.id)}" creation aborted`)
    return {
      handle: await persistence.create(session.header, {
        inheritedEventCount: session.inheritedEventCount,
        ...(signal === undefined ? {} : { signal }),
      }),
      storedCount: 0,
    }
  }

  /** Store events appended before the session entered the live event feed. */
  async #appendUnstored(stored, session) {
    if (stored === undefined) return
    const suffix = session.snapshotEvents(SessionLogOffset(stored.storedCount))
    if (suffix.length > 0) await stored.handle.append(suffix)
    stored.storedCount += suffix.length
  }

  /** Build the agent, publish it, and return the owned handle. */
  async #initialize(ownerCtx, { session, stored, agentOptions, setup, signal, source, parentAgent }) {
    const cwd = session.header.cwd ?? this.options.cwd
    const history = session.snapshotEvents()
    const sessionFile = history.length === 0 ? undefined : buildPiSessionFile({
      session,
      cwd,
      filePath: this.#sessionFile(session.id),
      logger: this.options.logger,
    })

    const rpc = new PiRpcClient({
      piPath: this.options.piPath,
      cwd,
      ...(sessionFile === undefined ? {} : { sessionFile }),
      logger: this.options.logger,
    })
    const requested = { ...routeOptions(this.options.model), ...agentOptions }
    const agent = new PiAgent({
      ctx: this.registryCtx,
      session,
      agentOptions: requested,
      rpc,
      cwd,
      logger: this.options.logger,
      startSource: source,
      requestHeader: this.options.requestHeader !== false,
      toolSchemas: () => this.registryCtx.get('tools')?.schemas?.() ?? [],
      ...(this.options.streamPaceMs === undefined ? {} : { streamPaceMs: this.options.streamPaceMs }),
      ...(this.options.streamCatchUpFrames === undefined ? {} : { streamCatchUpFrames: this.options.streamCatchUpFrames }),
      ...(this.options.streamMaxCharsPerFrame === undefined ? {} : { streamMaxCharsPerFrame: this.options.streamMaxCharsPerFrame }),
      ...(this.options.models === undefined ? {} : { modelMap: this.options.models }),
      ...(this.options.modelInfo === undefined ? {} : { modelInfo: this.options.modelInfo }),
    })
    // Align pi's route with the route this session already shows: prefer the
    // configured mapping, else try the DSH route verbatim (identical names).
    const requestedRoute = requested.provider === undefined || requested.model === undefined
      ? undefined
      : `${requested.provider}/${requested.model}`
    const route = splitRoute(this.options.models?.[requestedRoute] ?? requestedRoute ?? '')
    if (route !== undefined) {
      void rpc.setModel(route.provider, route.modelId).catch((error) => {
        this.options.logger?.(`[pi] set_model failed: ${String(error)}`)
      })
    }

    let detachSession
    let detachAgent
    let disposing
    const dispose = () =>
      (disposing ??= (async () => {
        try {
          agent.cancel({ kind: 'disposed' })
          await agent.whenIdle().catch(() => undefined)
          await agent.dispose()
        } finally {
          try {
            await stored?.handle.close()
          } finally {
            detachAgent?.()
            detachSession?.()
          }
        }
      })())
    const unfollowOwner = ownerCtx.effect(() => () => {
      if (disposing === undefined) void dispose()
    })

    try {
      await this.#appendUnstored(stored, session)
      detachSession = this.registryCtx.sessions.enter(session)
      this.registryCtx.sessions.announce(session)
      if (setup !== undefined) {
        const commit = await setup(agent.ctx, agent)
        commit?.commit()
      }
      detachAgent = this.registryCtx.agents.enter(agent, parentAgent)
      await this.registryCtx.agents.announce(agent, source, signal)
      emitAgentEvent(this.registryCtx, agent, 'agent/session-start', { source })
      const owned = () => dispose().then(() => undefined)
      this.live.add(owned)
      return {
        agent,
        dispose: () => {
          this.live.delete(owned)
          return owned()
        },
      }
    } catch (error) {
      unfollowOwner?.()
      await dispose()
      throw error
    }
  }

  async createAgent(ownerCtx, options) {
    const session = this.registryCtx.sessions.prepare(options.sessionId, {
      ...(options.meta === undefined ? {} : { meta: options.meta }),
      ...(options.seed === undefined ? {} : { seed: options.seed }),
      ...(options.inheritedEventCount === undefined ? {} : { inheritedEventCount: options.inheritedEventCount }),
    })
    const stored = await this.#createStored(session, options.signal)
    try {
      return await this.#initialize(ownerCtx, {
        session,
        stored,
        agentOptions: options.agentOptions ?? {},
        setup: options.setup,
        signal: options.signal,
        source: 'startup',
        parentAgent: options.parentAgent,
      })
    } catch (error) {
      await stored?.handle.close().catch(() => undefined)
      throw error
    }
  }

  async resume(ownerCtx, options) {
    const persistence = this.registryCtx.get('sessionPersistence')
    if (persistence === undefined) {
      throw new Error('cannot resume: session persistence is not configured (load a dsh-session-persistence backend)')
    }
    const id = options.resumeSessionId
    const handle = await persistence.open(id, 'write', {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    try {
      const coldRead = await handle.read(0, undefined, {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
      const persisted = coldRead.events
      // A log whose last turn never ended is closed before replay (crash repair).
      const closers = interruptedTurnClosers(persisted)
      if (closers.length > 0) await handle.append(closers)

      const session = this.registryCtx.sessions.prepare(id, {
        seed: [...persisted, ...closers],
        meta: structuredClone(handle.header),
        inheritedEventCount: handle.inheritedEventCount,
        eventState: coldRead.eventState,
      })
      return await this.#initialize(ownerCtx, {
        session,
        stored: { handle, storedCount: persisted.length + closers.length },
        agentOptions: options.agentOptions ?? {},
        setup: options.setup,
        signal: options.signal,
        source: 'resume',
        parentAgent: options.parentAgent,
      })
    } catch (error) {
      await handle.close().catch(() => undefined)
      throw error
    }
  }
}
