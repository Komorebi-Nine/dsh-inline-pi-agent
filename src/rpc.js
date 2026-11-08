/**
 * PiRpcClient — spawns a headless `pi --mode rpc` process and speaks its JSONL
 * protocol. Protocol reference: pi 1.5.0 `docs/rpc.md`, `docs/rpc-commands.md`.
 *
 * Adapted from dsh-pi-agent by Micheleww (MIT).
 */

import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'

const isWindows = process.platform === 'win32'

function cmdQuote(value) {
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/**
 * Windows cannot spawn a .cmd/.ps1 shim directly. Route .cmd through cmd.exe
 * as one command line, so no argument is re-split by the shell.
 */
function resolveSpawn(piPath, args) {
  if (!isWindows || /\.(exe|com)$/i.test(piPath)) return { file: piPath, args }
  const shim = /\.(cmd|bat)$/i.test(piPath) ? piPath : `${piPath}.cmd`
  const line = [shim, ...args].map(cmdQuote).join(' ')
  return { file: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', line] }
}

export class PiRpcClient {
  constructor({ piPath = 'pi', cwd, sessionFile, logger }) {
    this.cwd = cwd
    this.logger = logger
    this.closed = false
    this.nextId = 0
    this.buffer = ''
    this.pending = new Map()
    this.events = new EventEmitter()

    const args = ['--mode', 'rpc']
    if (sessionFile === undefined) args.push('--no-session')
    else args.push('--session', sessionFile)
    const { file, args: spawnArgs } = resolveSpawn(piPath, args)
    this.proc = spawn(file, spawnArgs, {
      cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    this.proc.stdout.setEncoding('utf8')
    this.proc.stdout.on('data', (chunk) => this.#onData(chunk))
    this.proc.stderr.setEncoding('utf8')
    this.proc.stderr.on('data', (chunk) => this.logger?.(`[pi:stderr] ${chunk.trimEnd()}`))
    this.proc.on('error', (error) => this.logger?.(`[pi:error] ${String(error)}`))
    this.proc.on('exit', (code, signal) => {
      this.closed = true
      this.logger?.(`[pi:exit] code=${String(code)} signal=${String(signal)}`)
      const failure = new Error(`pi exited (code=${String(code)} signal=${String(signal)})`)
      for (const entry of this.pending.values()) entry.reject(failure)
      this.pending.clear()
      this.events.emit('exit', { code, signal })
    })
  }

  get running() {
    return !this.closed
  }

  #onData(chunk) {
    this.buffer += chunk
    // Strict JSONL framing: split on LF only (U+2028/U+2029 are legal in strings).
    let index
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '')
      this.buffer = this.buffer.slice(index + 1)
      if (line.trim() === '') continue
      let record
      try {
        record = JSON.parse(line)
      } catch {
        this.logger?.(`[pi:bad-json] ${line.slice(0, 200)}`)
        continue
      }
      this.#dispatch(record)
    }
  }

  #dispatch(record) {
    if (record?.type === 'response') {
      const id = record.id ?? record.command
      const entry = this.pending.get(id)
      if (entry === undefined) return
      this.pending.delete(id)
      entry.resolve(record)
      return
    }
    this.events.emit('event', record)
  }

  /** Send one command and resolve with its correlated response envelope. */
  send(command) {
    if (this.closed) return Promise.reject(new Error('pi process is not running'))
    const id = command.id ?? `cmd-${++this.nextId}`
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.proc.stdin.write(`${JSON.stringify({ ...command, id })}\n`, (error) => {
        if (error) {
          this.pending.delete(id)
          reject(error)
        }
      })
    })
  }

  async prompt(message) {
    const response = await this.send({ type: 'prompt', message })
    if (!response.success) throw new Error(`pi prompt failed: ${response.error ?? 'unknown'}`)
    return response.data
  }

  async steer(message) {
    const response = await this.send({ type: 'steer', message })
    if (!response.success) throw new Error(`pi steer failed: ${response.error ?? 'unknown'}`)
  }

  async abort() {
    try {
      await this.send({ type: 'abort' })
    } catch {
      // The child may already be gone; abort is best-effort.
    }
  }

  async setModel(provider, modelId) {
    const response = await this.send({ type: 'set_model', provider, modelId })
    if (!response.success) throw new Error(response.error ?? 'pi set_model failed')
    return response.data
  }

  onEvent(listener) {
    this.events.on('event', listener)
    return () => this.events.off('event', listener)
  }

  onExit(listener) {
    this.events.on('exit', listener)
    return () => this.events.off('exit', listener)
  }

  /**
   * Stop the child. Closing stdin makes pi shut down after the active run
   * settles, so abort first — an open stdin is the only thing keeping a run
   * alive (see CONTRACT.md §9.1).
   */
  close() {
    if (this.closed) return
    this.closed = true
    try {
      this.proc.stdin.write(`${JSON.stringify({ type: 'abort', id: `close-${++this.nextId}` })}\n`)
    } catch {
      // stdin already closed
    }
    try {
      this.proc.stdin.end()
    } catch {
      // ignore
    }
    const timer = setTimeout(() => {
      try {
        this.proc.kill()
      } catch {
        // already gone
      }
    }, 2000)
    timer.unref?.()
  }
}
