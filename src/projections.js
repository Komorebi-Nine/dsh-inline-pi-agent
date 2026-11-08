/**
 * Session projections owned by the loop driver.
 *
 * `agent-loop` is not only a driver: it registers the `inbox` and
 * `modelSelection` projection units. Disabling it without registering them
 * leaves history reconstruction (and the client's pending-input view) without
 * the units it reads. This module supplies the same keys with the same fold
 * semantics.
 */

import { modelSelectionProjectionDefinition } from '@deepseek-ai/dsh-agent'

/** Identity schemas: state is plain JSON produced by this module only. */
const passthrough = { parse: (value) => value }

/** Pending input folded from `agent/inbox/spliced`, mirroring agent-loop's unit. */
export const inboxProjectionDefinition = {
  key: 'inbox',
  stateSchema: passthrough,
  init: () => ({ 'next-turn': [], 'next-step': [] }),
  apply(state, event) {
    if (event.type !== 'agent/inbox/spliced') return state
    const splice = event.data
    const target = splice.target
    const list = state[target]
    const removedCount = splice.removedCount ?? 0
    if (!Number.isSafeInteger(splice.start) || splice.start < 0 || splice.start > list.length) {
      throw new Error(`invalid persisted inbox splice at session seq ${String(event.seq)}`)
    }
    const next = list.toSpliced(splice.start, removedCount, ...(splice.inserted ?? []))
    const ids = new Set()
    for (const message of [...next, ...state[target === 'next-turn' ? 'next-step' : 'next-turn']]) {
      if (ids.has(message.id)) throw new Error(`message "${String(message.id)}" is already pending`)
      ids.add(message.id)
    }
    return target === 'next-turn'
      ? { 'next-turn': next, 'next-step': state['next-step'] }
      : { 'next-turn': state['next-turn'], 'next-step': next }
  },
  wire: { viewSchema: passthrough, view: (state) => state },
  stateVersion: 1,
}

/** Every unit a pi-driven session needs registered. */
export const projectionDefinitions = [inboxProjectionDefinition, modelSelectionProjectionDefinition]
