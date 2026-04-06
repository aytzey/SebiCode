import { describe, expect, test } from 'bun:test'
import { __testing } from './openai-adapter.js'

describe('openai-adapter', () => {
  test('translateMessages carries hidden codex reasoning without surfacing a thinking block', () => {
    const translated = __testing.translateMessages([
      {
        role: 'assistant',
        codex_encrypted_reasoning: [
          {
            id: 'rs_1',
            encrypted_content: { token: 'secret' },
          },
        ],
        content: [{ type: 'text', text: 'Implemented the change.' }],
      },
    ] as never)

    expect(translated).toEqual([
      {
        type: 'reasoning',
        id: 'rs_1',
        summary: [],
        encrypted_content: { token: 'secret' },
      },
      {
        role: 'assistant',
        content: 'Implemented the change.',
      },
    ])
  })

  test('translateMessages still understands legacy encrypted-thinking blocks for persisted transcripts', () => {
    const translated = __testing.translateMessages([
      {
        role: 'assistant',
        content: [
          {
            type: 'thinking',
            thinking:
              __testing.ENCRYPTED_REASONING_PREFIX +
              JSON.stringify({
                id: 'rs_legacy',
                encrypted_content: 'legacy-secret',
              }),
          },
          {
            type: 'text',
            text: 'Continuing from an older transcript.',
          },
        ],
      },
    ] as never)

    expect(translated).toEqual([
      {
        type: 'reasoning',
        id: 'rs_legacy',
        summary: [],
        encrypted_content: 'legacy-secret',
      },
      {
        role: 'assistant',
        content: 'Continuing from an older transcript.',
      },
    ])
  })
})
