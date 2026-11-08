/**
 * PiAgent — a DSH `Agent` whose driver is a headless pi process.
 *
 * Translates pi's RPC event stream into DSH durable session events plus the
 * process-local `agent/*` notifications the Web UI consumes.
 */

import { agentEvents } from '@deepseek-ai/dsh-agent'
import { ToolCallId, createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import { PiInbox } from './inbox.js'

const CONTENT_BLOCK_KIND = {
  text: 'text',
  thinking: 'reasoning',
  toolCall: 'tool-call',
}

/** Convert pi content blocks into DSH blocks; unknown kinds are dropped. */
function convertBlocks(content) {
  if (!Array.isArray(content)) return []
  const blocks = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    switch (CONTENT_BLOCK_KIND[block.type]) {
      case 'text':
        blocks.push({ type: 'text', text: typeof block.text === 'string' ? block.text : '' })
        break
      case 'reasoning':
        blocks.push({ type: 'reasoning', text: typeof block.thinking === 'string' ? block.thinking : '' })
        break
      case 'tool-call':
        blocks.push({
          type: 'tool-call',
          id: ToolCallId(String(block.id ?? '')),
          name: String(block.name ?? ''),
          arguments: JSON.stringify(block.arguments ?? {}),
        })
        break
      default:
        break
    }
  }
  return blocks
}

/** Map pi's usage counters onto DSH TokenUsage (see CONTRACT.md §6.3). */
function convertUsage(usage) {
  if (!usage || typeof usage !== 'object') return undefined
  return {
    inputTokens: Number(usage.input ?? 0),
    outputTokens: Number(usage.output ?? 0),
    ...(usage.totalTokens === undefined ? {} : { totalTokens: Number(usage.totalTokens) }),
    ...(usage.cacheRead === undefined ? {} : { cacheReadTokens: Number(usage.cacheRead) }),
    ...(usage.cacheWrite === undefined ? {} : { cacheWriteTokens: Number(usage.cacheWrite) }),
    ...(usage.reasoning === undefined ? {} : { reasoningTokens: Number(usage.reasoning) }),
  }
}

/** Flatten pi tool output into DSH tool-result text. */
function resultText(result) {
  if (typeof result === 'string') return result
  if (result && Array.isArray(result.content)) {
    const text = result.content
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
    if (text !== '') return text
  }
  return result === undefined ? '' : JSON.stringify(result)
}

/** Text carried by one DSH user message. */
function textOf(message) {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

/** Whether two queued deltas belong to the same coalesced run. */
function sameRun(first, next) {
  if (next.kind !== first.kind || next.contentIndex !== first.contentIndex) return false
  return first.kind !== 'tool-call' || (next.id === first.id && next.name === first.name)
}

export class PiAgent {
  constructor({ ctx, session, agentOptions, rpc, cwd, logger, modelMap, modelInfo, startSource, requestHeader, toolSchemas, streamFlushMs, streamFlushChars }) {
    this.id = session.id
    this.session = session
    this.options = agentOptions ?? {}
    this.rpc = rpc
    this.cwd = cwd
    this.logger = logger
    this.modelMap = modelMap
    this.modelInfo = modelInfo
    this.toolSchemas = toolSchemas
    this.startSource = startSource ?? 'startup'
    this.requestHeader = requestHeader !== false

    this._status = 'idle'
    this.scope = createScope(ctx, this)
    this.ctx = this.scope.ctx.extend({ agent: this })
    this.dispatch = agentEvents(ctx, this)
    this.inbox = new PiInbox({ session, dispatch: this.dispatch })
    this.model = new PiModel(session, this.options, (selection) => this.#applyModel(selection))

    this.driver = null
    // Resumed sessions continue the durable turn numbering.
    this.turn = ctx.agents?.turnBoundaryOf(session).lastTurn ?? 0
    this.step = 0
    this.stepOpen = false
    this.aborted = false
    this.cancelCause = { kind: 'user' }
    this.attempt = null
    this.attemptSeq = 0
    this.pendingDeltas = []
    this.pendingChars = 0
    this.pendingTimer = null
    this.flushMs = streamFlushMs ?? 20
    this.flushChars = streamFlushChars ?? 1024
    this.frameRevision = 0
    this.toolCallSeqs = new Map()
    this.settleWaiters = []
    this.disposed = false
    this.rpcExited = null
    this.lastHeaderKey = undefined
    this.lastContextKey = undefined

    this.unwatch = this.rpc.onEvent((event) => this.#onPiEvent(event))
    this.unwatchExit = this.rpc.onExit((info) => {
      this.rpcExited = info
      const waiters = this.settleWaiters.splice(0)
      for (const resolve of waiters) resolve()
    })
    this.dispatch.emit('agent/status', { status: 'idle' })
  }

  get status() {
    return this._status
  }

  // ---- Agent interface ----

  send(message, target, wakeup) {
    this.inbox.append(target, message)
    if (wakeup) this.#wake()
  }

  followup(message) {
    this.inbox.append('next-turn', message)
    this.#wake()
  }

  steer(message) {
    this.inbox.append('next-step', message)
    if (this._status === 'running' && this.rpc.running) {
      // pi owns the mid-run delivery: claim once it accepts, so the inbox does
      // not keep a steer that already reached the engine.
      void this.rpc
        .steer(textOf(message))
        .then(() => this.inbox.claimMessage(message.id, this.turn))
        .catch(() => undefined)
    } else {
      this.#wake()
    }
  }

  inject(message) {
    this.inbox.append('next-step', message)
  }

  cancel(cause, options) {
    this.#flushDeltas()
    this.cancelCause = cause
    if (options?.keepInbox !== true) this.inbox.clear()
    // A cancellation with no active work is a no-op: it must not arm later work.
    if (this._status !== 'running') return
    this.aborted = true
    void this.rpc.abort().catch(() => undefined)
  }

  whenIdle() {
    return this.driver === null ? Promise.resolve() : this.driver.then(() => undefined)
  }

  runMaintenance(task) {
    return task(new AbortController().signal)
  }

  // ---- driver ----

  #wake() {
    if (this.driver !== null || this.disposed) return
    this.driver = this.#drive().finally(() => {
      this.driver = null
      this.#setStatus('idle')
    })
  }

  async #drive() {
    this.#setStatus('running')
    try {
      for (;;) {
        const next = this.inbox.nextTurn[0]
        if (next === undefined || this.aborted) break
        this.inbox.claimTurn(this.turn + 1)
        await this.#runTurn(next)
      }
    } finally {
      this.aborted = false
    }
  }

  async #runTurn(message) {
    this.turn += 1
    this.step = 0
    this.toolCallSeqs.clear()
    const turn = this.turn

    this.session.append('turn/start', { turn })
    this.session.append('user/message', message, { surfaceOp: 'append' })

    let failure
    try {
      const steered = this.inbox.claimStep(turn).map((item) => textOf(item))
      const prompt = [textOf(message), ...steered].filter((text) => text !== '').join('\n')
      await this.rpc.prompt(prompt)
      await this.#waitSettled()
      if (this.rpcExited !== null) {
        throw new Error(`pi process exited (code=${String(this.rpcExited.code)} signal=${String(this.rpcExited.signal)})`)
      }
    } catch (error) {
      failure = error
    } finally {
      this.#closeStep()
      // A cancelled turn settles through `agent_settled` without rejecting, so
      // the flag — not just the catch path — decides the end reason.
      const reason = this.aborted
        ? { kind: 'aborted', reason: this.cancelCause }
        : failure === undefined
          ? { kind: 'completed' }
          : { kind: 'error', error: { message: String(failure), code: 'UNKNOWN' } }
      this.session.append('turn/end', { turn, reason })
    }
  }

  #waitSettled() {
    return new Promise((resolve) => {
      this.settleWaiters.push(resolve)
    })
  }

  #setStatus(status) {
    if (this._status === status) return
    this._status = status
    this.dispatch.emit('agent/status', { status })
  }

  #openStep() {
    if (this.stepOpen) return
    this.step += 1
    this.stepOpen = true
    this.session.append('step/start', { turn: this.turn, step: this.step })
  }

  #closeStep() {
    if (!this.stepOpen) return
    this.stepOpen = false
    this.session.append('step/end', { turn: this.turn, step: this.step })
  }

  /**
   * Record the route of the request this step is about to send.
   *
   * DSH's token meter only adopts provider-reported usage when the step has a
   * `request/header` before its `assistant/message`; without one it falls back
   * to a heuristic estimate (wrong TTFT and context occupancy). pi owns the
   * request, so the honest header is the route we forwarded to it.
   */
  #recordRequest() {
    if (this.requestHeader === false) return
    const selection = this.model.current()
    if (selection === undefined) return

    const config = {
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
    }
    // Declaring the registry's tools keeps a later native-loop resume
    // consistent: an empty tool list would make every tool look newly added
    // (and deferred) to that loop.
    const tools = this.toolSchemas?.() ?? []
    const header = { config, ...(tools.length === 0 ? {} : { tools }) }
    const configKey = JSON.stringify(header)
    if (configKey !== this.lastHeaderKey) {
      const reason = this.lastHeaderKey === undefined
        ? (this.startSource === 'resume' ? 'resume' : 'initial')
        : 'change'
      this.session.append('request/header', { header, reason })
      this.lastHeaderKey = configKey
    }

    const info = this.modelInfo?.(selection.provider, selection.model)
    const context = {
      provider: selection.provider,
      model: selection.model,
      ...(info?.contextWindow === undefined ? {} : { contextWindow: info.contextWindow }),
    }
    const contextKey = JSON.stringify(context)
    if (contextKey !== this.lastContextKey) {
      this.session.append('request/context', context)
      this.lastContextKey = contextKey
    }
  }

  // ---- pi event translation ----

  #onPiEvent(event) {
    switch (event.type) {
      case 'turn_start':
        this.#openStep()
        this.#recordRequest()
        return
      case 'turn_end':
        this.#flushDeltas()
        this.#closeStep()
        return
      case 'message_start':
        if (event.message?.role === 'assistant') {
          this.#openStep()
          this.#startAttempt()
        }
        return
      case 'message_update':
        this.#onUpdate(event)
        return
      case 'message_end':
        if (event.message?.role === 'assistant') {
          this.#openStep()
          this.#finishAttempt(event.message)
        }
        return
      case 'tool_execution_start':
        this.#onToolStart(event)
        return
      case 'tool_execution_end':
        this.#onToolEnd(event)
        return
      case 'agent_settled': {
        const waiters = this.settleWaiters.splice(0)
        for (const resolve of waiters) resolve()
        return
      }
      default:
        return
    }
  }

  #startAttempt() {
    this.attemptSeq += 1
    this.attempt = { id: `pi-${String(this.attemptSeq)}`, index: 0, records: [], toolCalls: new Map() }
    this.dispatch.emit('agent/assistant-stream', {
      frame: {
        type: 'start',
        attemptId: this.attempt.id,
        revision: ++this.frameRevision,
        turn: this.turn,
        step: this.step,
      },
    })
  }

  #onUpdate(event) {
    const attempt = this.attempt
    const update = event.assistantMessageEvent
    if (attempt === null || update === undefined) return
    const contentIndex = update.contentIndex ?? 0

    if (update.type === 'toolcall_start') {
      attempt.toolCalls.set(contentIndex, { id: String(update.id ?? ''), name: update.toolName })
      return
    }

    let delta
    if (update.type === 'text_delta') {
      delta = { kind: 'text', contentIndex, text: update.delta ?? '' }
    } else if (update.type === 'thinking_delta') {
      delta = { kind: 'reasoning', contentIndex, text: update.delta ?? '' }
    } else if (update.type === 'toolcall_delta') {
      const tool = attempt.toolCalls.get(contentIndex)
      if (tool === undefined || tool.id === '') return
      delta = { kind: 'tool-call', contentIndex, text: update.delta ?? '', id: tool.id, name: tool.name }
    } else {
      return
    }
    if (delta.text === '') return
    delta.time = Date.now()
    this.#queueDelta(delta)
  }

  /**
   * pi streams one delta per token, which is far more frames than a browser
   * needs. Batch them into short windows: the client still receives dense
   * frames, and the durable stream packs each window into one record.
   */
  #queueDelta(delta) {
    this.pendingDeltas.push(delta)
    this.pendingChars += delta.text.length
    // Bound memory and chunk size: a burst flushes immediately.
    if (this.pendingChars >= this.flushChars) {
      this.#flushDeltas()
      return
    }
    if (this.pendingTimer !== null) return
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null
      this.#flushDeltas()
    }, this.flushMs)
    this.pendingTimer.unref?.()
  }

  #flushDeltas() {
    if (this.pendingTimer !== null) {
      clearTimeout(this.pendingTimer)
      this.pendingTimer = null
    }
    const attempt = this.attempt
    const pending = this.pendingDeltas.splice(0, this.pendingDeltas.length)
    this.pendingChars = 0
    if (attempt === null || pending.length === 0) return
    let cursor = 0
    while (cursor < pending.length) {
      const first = pending[cursor]
      let end = cursor + 1
      while (end < pending.length && sameRun(first, pending[end])) end += 1
      this.#emitRun(attempt, pending.slice(cursor, end))
      cursor = end
    }
  }

  /** Emit one coalesced chunk frame plus its packed durable record. */
  #emitRun(attempt, members) {
    const first = members[0]
    const texts = members.map((member) => member.text)
    const times = members.map((member) => member.time)
    const dt = []
    for (let index = 1; index < times.length; index += 1) dt.push(Math.max(0, times[index] - times[index - 1]))
    const time0 = times[0]
    const lastTime = times[times.length - 1]

    if (first.kind === 'text') {
      attempt.records.push({ type: 'text-chunks', time0, index: first.contentIndex, dt, texts })
    } else if (first.kind === 'reasoning') {
      attempt.records.push({ type: 'reasoning-chunks', time0, index: first.contentIndex, dt, texts })
    } else {
      attempt.records.push({
        type: 'tool-call-chunks',
        time0,
        index: first.contentIndex,
        dt,
        id: first.id,
        ...(first.name === undefined ? {} : { name: first.name }),
        args: texts,
      })
    }

    const text = texts.join('')
    const chunk = first.kind === 'text'
      ? { type: 'text-delta', index: first.contentIndex, text }
      : first.kind === 'reasoning'
        ? { type: 'reasoning-delta', index: first.contentIndex, text }
        : {
            type: 'tool-call-delta',
            index: first.contentIndex,
            id: ToolCallId(first.id),
            ...(first.name === undefined ? {} : { name: first.name }),
            argumentsDelta: text,
          }

    this.dispatch.emit('agent/assistant-stream', {
      frame: {
        type: 'chunk',
        attemptId: attempt.id,
        revision: ++this.frameRevision,
        index: attempt.index,
        time: lastTime,
        chunk,
      },
    })
    attempt.index += 1
  }

  #finishAttempt(message) {
    this.#flushDeltas()
    const attempt = this.attempt
    this.attempt = null
    const blocks = convertBlocks(message.content)
    const source = {
      provider: typeof message.provider === 'string' ? message.provider : (this.options.provider ?? ''),
      model: typeof message.model === 'string' ? message.model : (this.options.model ?? ''),
    }
    if (blocks.length === 0) {
      if (attempt !== null) {
        this.dispatch.emit('agent/assistant-stream', {
          frame: {
            type: 'end',
            attemptId: attempt.id,
            revision: ++this.frameRevision,
            index: attempt.index,
            outcome: { kind: 'abandoned' },
          },
        })
      }
      return
    }

    const interrupted = message.stopReason === 'aborted'
    const usage = convertUsage(message.usage)
    const event = this.session.append(
      'assistant/message',
      {
        turn: this.turn,
        step: this.step,
        message: createAssistantMessage({ content: blocks, source }),
        stream: attempt?.records ?? [],
        ...(usage === undefined ? {} : { usage }),
        ...(interrupted ? { interrupted: true } : {}),
      },
      { surfaceOp: 'append' },
    )

    if (attempt !== null) {
      this.dispatch.emit('agent/assistant-stream', {
        frame: {
          type: 'end',
          attemptId: attempt.id,
          revision: ++this.frameRevision,
          index: attempt.index,
          outcome: { kind: 'committed', eventType: 'assistant/message', seq: event.seq },
        },
      })
    }
  }

  #onToolStart(event) {
    this.#flushDeltas()
    this.#openStep()
    const callId = ToolCallId(String(event.toolCallId ?? ''))
    const callEvent = this.session.append('tool/call', {
      turn: this.turn,
      step: this.step,
      callId,
      name: String(event.toolName ?? ''),
      arguments: JSON.stringify(event.args ?? {}),
    })
    this.toolCallSeqs.set(String(callId), callEvent.seq)
  }

  #onToolEnd(event) {
    this.#openStep()
    const callId = ToolCallId(String(event.toolCallId ?? ''))
    const callSeq = this.toolCallSeqs.get(String(callId))
    const text = resultText(event.result)
    const message = createToolResultMessage({
      callId,
      content: text === '' ? [] : [{ type: 'text', text }],
      isError: event.isError === true,
    })
    this.session.append(
      'tool/result',
      { turn: this.turn, step: this.step, message },
      { surfaceOp: 'append', ...(callSeq === undefined ? {} : { sourceEventSeqs: [callSeq] }) },
    )
  }

  /** Push a selected route to pi, honouring the configured route mapping. */
  #applyModel(selection) {
    const key = `${selection.provider}/${selection.model}`
    const route = this.modelMap?.[key] ?? key
    const separator = route.indexOf('/')
    if (separator === -1) {
      this.logger?.(`[pi] model "${key}" has no provider/model mapping; left pi's model unchanged`)
      return
    }
    void this.rpc
      .setModel(route.slice(0, separator), route.slice(separator + 1))
      .catch((error) => this.logger?.(`[pi] set_model failed for ${key}: ${String(error)}`))
  }

  /** Stop the driver and the pi child, then unwind the scoped context. */
  async dispose() {
    if (this.disposed) return
    this.disposed = true
    this.aborted = true
    this.#flushDeltas()
    this.unwatch?.()
    this.unwatchExit?.()
    this.rpc.close()
    this.#closeStep()
    await this.scope.dispose()
  }
}

/** Minimal durable model selection: reads initial options, records `select()`. */
class PiModel {
  constructor(session, options, onSelect) {
    this.session = session
    this.options = options
    this.onSelect = onSelect
    this.selected = undefined
  }

  current() {
    if (this.selected !== undefined) return { ...this.selected }
    const { provider, model, reasoningEffort } = this.options
    if (provider === undefined || model === undefined) return undefined
    return { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }
  }

  select(selection) {
    this.selected = { ...selection }
    this.session.append('model/selection', { ...selection })
    this.onSelect?.(selection)
  }
}


