/**
 * P0 smoke test: boot the minimum services, mount dsh-pi-agent, run one turn,
 * and dump durable session events plus live agent frames. Not shipped.
 *
 * Usage: node scripts/smoke.mjs [text|tool] [prompt]
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as SessionStats from '@deepseek-ai/dsh-session-stats'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import * as piAgentPlugin from '../src/index.js'

const mode = process.argv[2] ?? 'text'
const defaultPrompt =
  mode === 'tool'
    ? 'Use the read tool to read probe.txt, then reply with only its first line.'
    : 'Reply with exactly: SMOKE_OK'
const prompt = process.argv[3] ?? defaultPrompt

const workdir = join(process.cwd(), '.tmp-smoke')
mkdirSync(workdir, { recursive: true })
writeFileSync(join(workdir, 'probe.txt'), 'smoke line one\nsmoke line two\n')
const sessionRoot = join(workdir, 'session-logs')
if (mode === 'resume') rmSync(sessionRoot, { recursive: true, force: true })
mkdirSync(sessionRoot, { recursive: true })

const live = { status: [], frames: [], inbox: [] }
const ctx = new Context()
ctx.on('agent/status', (payload) => live.status.push(payload.status))
ctx.on('agent/assistant-stream', (payload) => live.frames.push(payload.frame))
ctx.on('agent/inbox/inserted', () => live.inbox.push('inserted'))
ctx.on('agent/inbox/claimed', () => live.inbox.push('claimed'))

ctx.plugin(TypertRegistry)
ctx.plugin(SessionProjectionRegistry)
ctx.plugin(SessionStore)
ctx.plugin(JsonlPersistence, { root: sessionRoot })
ctx.plugin(LlmRuntime)
ctx.plugin(AgentRegistry)
ctx.plugin(TokenMeter)
ctx.plugin(SessionStats)
const pluginFiber = ctx.plugin(piAgentPlugin, {
  piPath: process.env.PI_PATH ?? 'pi',
  cwd: workdir,
  debug: true,
  requestHeader: process.env.PI_HEADER !== '0',
  models: { 'deepseek-official/deepseek-flash': 'deepseek/deepseek-flash' },
})

const waitFor = async (name, timeoutMs = 20000) => {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const service = ctx.get(name)
    if (service !== undefined) return service
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`timeout waiting for service: ${name}`)
}

const agents = await waitFor('agents')
await waitFor('sessions')
await waitFor('sessionPersistence')
const llm = await waitFor('llm')

/** The plugin applies asynchronously (projections + catalog probe), so retry. */
const createAgent = async (options) => {
  const deadline = Date.now() + 30000
  for (;;) {
    try {
      return await agents.create(options)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes('no agent factory') || Date.now() > deadline) throw error
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
}

if (mode === 'catalog') {
  // The plugin registers its catalog asynchronously (it probes a pi child first).
  const deadline = Date.now() + 30000
  while (llm.listProviders().length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  for (const provider of llm.listProviders()) {
    const models = await llm.listModels(provider.id)
    console.log(`${provider.id} (${provider.name}): ${models.map((model) => model.id).join(', ')}`)
    const first = models[0]
    if (first !== undefined) {
      const resolved = await llm.resolveModelInfo(provider.id, first.id)
      console.log(`  resolve ${first.id}: context=${resolved.context?.contextWindow ?? '-'} efforts=${(resolved.reasoning?.efforts ?? []).map((effort) => effort.id).join('|') || '-'}`)
    }
  }
  process.exit(0)
}

const dump = (session) => {
  console.log(`--- session ${String(session.id)} (${String(session.snapshotEvents().length)} events) ---`)
  for (const event of session.ownEvents()) {
    let data = JSON.stringify(event.data)
    if (event.type === 'assistant/message') {
      const record = event.data
      const kinds = record.message.content.map((block) => block.type).join(',')
      const text = record.message.content.filter((block) => block.type === 'text').map((block) => block.text).join(' ')
      const source = `${String(record.message.source?.provider)}/${String(record.message.source?.model)}`
      data = `source=${source} blocks=[${kinds}] stream=${String(record.stream.length)} interrupted=${String(record.interrupted ?? false)} text=${JSON.stringify(text.slice(0, 100))}`
    } else if (event.type === 'model/selection') {
      data = JSON.stringify(event.data)
    } else if (event.type === 'tool/result') {
      data = `callId=${String(event.data.message.toolCallId)} sourceEventSeqs=${JSON.stringify(event.sourceEventSeqs)}`
    } else if (event.type === 'user/message') {
      data = JSON.stringify(event.data.content)
    }
    console.log(`${String(event.seq).padStart(3)} ${event.type.padEnd(20)} ${data.length > 200 ? `${data.slice(0, 200)}…` : data}`)
  }
}

const ask = async (agent, text) => {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

if (mode === 'reload') {
  // Simulate a live bundle toggle: unload the plugin fiber, then apply it again.
  const first = await createAgent({
    sessionId: SessionId(`reload-a-${Date.now().toString(36)}`),
    meta: { cwd: workdir },
    agentOptions: { provider: 'deepseek', model: 'deepseek-flash' },
  })
  await ask(first.agent, 'Reply with exactly: RELOAD_A')
  console.log('first turn ok')
  await first.dispose()
  await pluginFiber.dispose()
  console.log('plugin unloaded')
  const second = ctx.plugin(piAgentPlugin, {
    piPath: process.env.PI_PATH ?? 'pi',
    cwd: workdir,
    debug: true,
    models: { 'deepseek-official/deepseek-flash': 'deepseek/deepseek-flash' },
  })
  const handle = await createAgent({
    sessionId: SessionId(`reload-b-${Date.now().toString(36)}`),
    meta: { cwd: workdir },
    agentOptions: { provider: 'deepseek', model: 'deepseek-flash' },
  })
  await ask(handle.agent, 'Reply with exactly: RELOAD_B')
  console.log('second turn ok')
  dump(handle.agent.session)
  await handle.dispose()
  await second.dispose()
  console.log('reload cycle ok')
  process.exit(0)
}

if (mode === 'checks') {
  // 1) non-absolute cwd must be rejected by the session store.
  try {
    ctx.sessions.prepare(SessionId('bad-cwd'), { meta: { cwd: 'relative/path' } })
    console.log('relative cwd: ACCEPTED (unexpected)')
  } catch (error) {
    console.log('relative cwd rejected:', error instanceof Error ? error.message : String(error))
  }

  // 2) an assistant settlement with an empty embedded stream must be storable.
  const handle = await createAgent({
    sessionId: SessionId(`checks-${Date.now().toString(36)}`),
    meta: { cwd: workdir },
    agentOptions: { provider: 'deepseek', model: 'deepseek-flash' },
  })
  const session = handle.agent.session
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'probe' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('request/header', { header: { config: { provider: 'deepseek', model: 'deepseek-flash' } }, reason: 'initial' })
  try {
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({ content: [{ type: 'text', text: 'hi' }], source: { provider: 'deepseek', model: 'deepseek-flash' } }),
      stream: [],
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const snapshot = ctx.sessionProjections.snapshot(session, ['tokenUsage', 'contextBreakdown', 'sessionStats'])
    console.log('empty stream: ACCEPTED; stats =', JSON.stringify(snapshot.values.sessionStats))
  } catch (error) {
    console.log('empty stream rejected:', error instanceof Error ? error.message : String(error))
  }
  await handle.dispose()
  process.exit(0)
}

if (mode === 'dispose' || mode === 'dispose-tool') {
  const disposePrompt = mode === 'dispose-tool'
    ? 'Use your shell tool to run this exact command and wait for it: powershell -NoProfile -Command "Start-Sleep -Seconds 30"'
    : 'Count from 1 to 3000, one number per line.'
  const handle = await createAgent({
    sessionId: SessionId(`dispose-${Date.now().toString(36)}`),
    meta: { cwd: workdir },
    agentOptions: { provider: 'deepseek', model: 'deepseek-flash' },
  })
  handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: disposePrompt }], source: { kind: 'user' } }))
  await new Promise((resolve) => setTimeout(resolve, mode === 'dispose-tool' ? 3000 : 1500))
  await handle.dispose()
  console.log('disposed while streaming; remaining events:')
  for (const event of handle.agent.session.ownEvents().slice(-8)) {
    console.log(` ${String(event.seq).padStart(3)} ${event.type}`)
  }
  process.exit(0)
}

if (mode === 'steer' || mode === 'followup' || mode === 'token') {
  const handle = await createAgent({
    sessionId: SessionId(`smoke-${mode}-${Date.now().toString(36)}`),
    meta: { cwd: workdir },
    agentOptions: { provider: 'deepseek', model: 'deepseek-flash' },
  })
  if (mode === 'steer') {
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Count from 1 to 3000, one number per line, no other text.' }], source: { kind: 'user' } }))
    setTimeout(() => {
      handle.agent.steer(createUserMessage({ content: [{ type: 'text', text: 'Stop counting now and reply with exactly: STEERED' }], source: { kind: 'user' } }))
    }, 1500)
  } else if (mode === 'followup') {
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Reply with exactly: FIRST' }], source: { kind: 'user' } }))
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Reply with exactly: SECOND' }], source: { kind: 'user' } }))
  } else {
    await ask(handle.agent, 'Reply with exactly: TOKEN_OK')
  }
  await handle.agent.whenIdle()
  dump(handle.agent.session)
  if (mode === 'token') {
    const snapshot = ctx.sessionProjections.snapshot(handle.agent.session, ['tokenMeasurement', 'tokenUsage', 'contextBreakdown', 'sessionStats'])
    console.log('--- projections @', snapshot.asOfSeq, '---')
    console.log(JSON.stringify(snapshot.values, null, 2))
  }
  await handle.dispose()
  process.exit(0)
}

if (mode === 'resume') {
  const sessionId = SessionId('smoke-resume')
  const first = await createAgent({
    sessionId,
    meta: { cwd: workdir },
    agentOptions: { provider: 'deepseek', model: 'deepseek-flash' },
  })
  await ask(first.agent, 'Remember this number: 42. Reply with just OK.')
  dump(first.agent.session)
  await first.dispose()
  console.log('--- first handle disposed, resuming ---')

  const resumed = await agents.resume({
    resumeSessionId: sessionId,
    agentOptions: { provider: 'deepseek', model: 'deepseek-flash' },
  })
  await ask(resumed.agent, 'What number did I ask you to remember? Reply with just the number.')
  dump(resumed.agent.session)
  await resumed.dispose()
  console.log('--- resumed handle disposed ---')
  process.exit(0)
}

const handle = await createAgent({
  sessionId: SessionId(`smoke-${Date.now().toString(36)}`),
  meta: { cwd: workdir },
  agentOptions: { provider: 'deepseek', model: 'deepseek-flash' },
})

await ask(handle.agent, prompt)
if (mode === 'model') {
  handle.agent.model.select({ provider: 'deepseek-official', model: 'deepseek-flash' })
  console.log('selection after select():', JSON.stringify(handle.agent.model.current()))
  await ask(handle.agent, 'Reply with exactly: MODEL_OK')
}
if (mode === 'multi') await ask(handle.agent, 'Which file did you read last? Answer in one short sentence.')
if (mode === 'abort') {
  handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Count from 1 to 3000, one number per line, no other text.' }], source: { kind: 'user' } }))
  setTimeout(() => {
    handle.agent.cancel({ kind: 'user' })
  }, 800)
  await handle.agent.whenIdle()
}

dump(handle.agent.session)

console.log('--- live agent events ---')
console.log('status:', live.status.join(' → '))
console.log('inbox:', live.inbox.join(' → '))
const frames = live.frames
const starts = frames.filter((frame) => frame.type === 'start').length
const ends = frames.filter((frame) => frame.type === 'end').length
const chunks = frames.filter((frame) => frame.type === 'chunk')
const chunkKinds = [...new Set(chunks.map((frame) => frame.chunk.type))].join(',')
console.log(`assistant-stream: start=${String(starts)} chunk=${String(chunks.length)}(${chunkKinds}) end=${String(ends)}`)
console.log('revisions:', frames.map((entry) => entry.revision).join(','))
if (ends > 0) console.log('settle outcome:', JSON.stringify(frames.at(-1).outcome))

await handle.dispose()
console.log('--- disposed ---')
process.exit(0)
