/**
 * PiInbox — the durable pending-work lists behind `Agent.inbox`.
 *
 * Every mutation commits one `agent/inbox/spliced` event; the live
 * `agent/inbox/*` notifications follow that commit (see dsh-agent README).
 */

export class PiInbox {
  constructor({ session, dispatch }) {
    this.session = session
    this.dispatch = dispatch
    this.nextTurn = []
    this.nextStep = []
    this.#fold(session)
  }

  /** Rebuild pending lists from committed splices (resume / restored seeds). */
  #fold(session) {
    for (const event of session.snapshotEvents()) {
      if (event.type !== 'agent/inbox/spliced') continue
      const { target, start, removedCount, inserted } = event.data
      const list = target === 'next-turn' ? this.nextTurn : this.nextStep
      list.splice(start, removedCount ?? 0, ...(inserted ?? []))
    }
  }

  #list(target) {
    if (target === 'next-turn') return this.nextTurn
    if (target === 'next-step') return this.nextStep
    throw new Error(`unknown inbox target: ${String(target)}`)
  }

  #splice(target, start, deleteCount, inserted, outcome) {
    const list = this.#list(target)
    const removed = list.splice(start, deleteCount, ...inserted)
    this.session.append('agent/inbox/spliced', {
      target,
      start,
      ...(removed.length > 0 ? { removedCount: removed.length } : {}),
      inserted: [...inserted],
      ...(outcome === undefined ? {} : { outcome }),
    })
    return removed
  }

  append(target, message) {
    const list = this.#list(target)
    this.#splice(target, list.length, 0, [message])
    this.dispatch.emit('agent/inbox/inserted', { message })
  }

  prepend(target, message) {
    this.#splice(target, 0, 0, [message])
    this.dispatch.emit('agent/inbox/inserted', { message })
  }

  replace(messageId, newMessage) {
    for (const target of ['next-turn', 'next-step']) {
      const list = this.#list(target)
      const index = list.findIndex((message) => message.id === messageId)
      if (index === -1) continue
      this.#splice(target, index, 1, [newMessage])
      this.dispatch.emit('agent/inbox/inserted', { message: newMessage })
      return true
    }
    return false
  }

  remove(messageId) {
    for (const target of ['next-turn', 'next-step']) {
      const list = this.#list(target)
      const index = list.findIndex((message) => message.id === messageId)
      if (index === -1) continue
      const [removed] = this.#splice(target, index, 1, [], 'canceled')
      if (removed !== undefined) this.dispatch.emit('agent/inbox/discarded', { message: removed })
      return true
    }
    return false
  }

  /** Claim one queued turn prompt: a pure removal, not a cancellation. */
  claimTurn(turn) {
    if (this.nextTurn.length === 0) return undefined
    const [message] = this.#splice('next-turn', 0, 1, [])
    if (message !== undefined) this.dispatch.emit('agent/inbox/claimed', { message, turn })
    return message
  }

  /** Claim one pending message by id (delivered to the driver/engine). */
  claimMessage(messageId, turn) {
    for (const target of ['next-step', 'next-turn']) {
      const list = this.#list(target)
      const index = list.findIndex((message) => message.id === messageId)
      if (index === -1) continue
      const [message] = this.#splice(target, index, 1, [])
      if (message !== undefined) this.dispatch.emit('agent/inbox/claimed', { message, turn })
      return true
    }
    return false
  }

  /** Claim every pending next-step message for the step about to start. */
  claimStep(turn) {
    if (this.nextStep.length === 0) return []
    const removed = this.#splice('next-step', 0, this.nextStep.length, [])
    for (const message of removed) this.dispatch.emit('agent/inbox/claimed', { message, turn })
    return removed
  }

  clear() {
    for (const target of ['next-step', 'next-turn']) {
      const list = this.#list(target)
      if (list.length === 0) continue
      const removed = this.#splice(target, 0, list.length, [], 'canceled')
      for (const message of removed) this.dispatch.emit('agent/inbox/discarded', { message })
    }
  }
}
