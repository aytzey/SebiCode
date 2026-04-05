import { getEventListeners } from 'node:events'
import { describe, expect, test } from 'bun:test'
import { createCombinedAbortSignal } from './combinedAbortSignal.js'

describe('createCombinedAbortSignal', () => {
  test('removes forwarded abort listeners during cleanup', () => {
    const parent = new AbortController()
    const before = getEventListeners(parent.signal, 'abort').length

    const combined = createCombinedAbortSignal(parent.signal, { timeoutMs: 1_000 })

    expect(getEventListeners(parent.signal, 'abort')).toHaveLength(before + 1)

    combined.cleanup()

    expect(getEventListeners(parent.signal, 'abort')).toHaveLength(before)
  })

  test('aborts the combined signal when the parent aborts', () => {
    const parent = new AbortController()
    const combined = createCombinedAbortSignal(parent.signal)

    parent.abort(new Error('stop'))

    expect(combined.signal.aborted).toBe(true)

    combined.cleanup()
  })
})
