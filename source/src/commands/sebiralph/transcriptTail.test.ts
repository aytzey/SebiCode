import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  loadRecentAssistantTextEntries,
  loadTranscriptTailEntries,
} from './transcriptTail.js'

async function withTempFile(
  contents: string,
  fn: (filePath: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'sebiralph-tail-'))
  const filePath = join(dir, 'session.jsonl')
  await writeFile(filePath, contents, 'utf8')
  try {
    await fn(filePath)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('loadTranscriptTailEntries', () => {
  test('returns newest-first entries from the end of the file', async () => {
    const lines: string[] = []
    for (let i = 0; i < 10; i += 1) {
      lines.push(
        JSON.stringify({
          type: 'assistant',
          isSidechain: false,
          message: { content: [{ type: 'text', text: `entry-${i}` }] },
        }),
      )
    }
    await withTempFile(lines.join('\n') + '\n', async filePath => {
      const entries = await loadTranscriptTailEntries(filePath, {
        maxEntries: 3,
      })
      expect(entries).toHaveLength(3)
      const texts = entries.map(entry => {
        const content = entry.message?.content
        if (!Array.isArray(content)) return ''
        const block = content[0] as { text?: string } | undefined
        return block?.text ?? ''
      })
      expect(texts).toEqual(['entry-9', 'entry-8', 'entry-7'])
    })
  })

  test('honors a custom filter and skips non-matching entries', async () => {
    const lines = [
      JSON.stringify({ type: 'user', message: { content: 'older user' } }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'older asst' }] },
      }),
      JSON.stringify({ type: 'user', message: { content: 'newest user' } }),
    ]
    await withTempFile(lines.join('\n') + '\n', async filePath => {
      const entries = await loadTranscriptTailEntries(filePath, {
        maxEntries: 5,
        filter: entry => entry.type === 'assistant',
      })
      expect(entries).toHaveLength(1)
      expect(entries[0]!.type).toBe('assistant')
    })
  })

  test('stitches lines that span the chunk boundary', async () => {
    const longText = 'x'.repeat(96 * 1024)
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: longText }] },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'tail' }] },
      }),
    ]
    await withTempFile(lines.join('\n') + '\n', async filePath => {
      const entries = await loadTranscriptTailEntries(filePath, {
        maxEntries: 5,
      })
      expect(entries).toHaveLength(2)
      const tailContent = entries[0]!.message?.content as Array<{
        text: string
      }>
      const headContent = entries[1]!.message?.content as Array<{
        text: string
      }>
      expect(tailContent[0]!.text).toBe('tail')
      expect(headContent[0]!.text).toBe(longText)
    })
  })

  test('caps the read by maxBytes even when more entries exist', async () => {
    // Each entry is ~8 KB. With a 32 KB byte cap and 30 total entries, the
    // reader should return some recent ones but not all of them.
    const padding = 'y'.repeat(8 * 1024)
    const lines: string[] = []
    for (let i = 0; i < 30; i += 1) {
      lines.push(
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: `${padding}-${i}` }] },
        }),
      )
    }
    await withTempFile(lines.join('\n') + '\n', async filePath => {
      const entries = await loadTranscriptTailEntries(filePath, {
        maxEntries: 1000,
        maxBytes: 32 * 1024,
      })
      expect(entries.length).toBeLessThan(30)
      expect(entries.length).toBeGreaterThan(0)
    })
  })

  test('returns an empty list for a missing file without throwing', async () => {
    const entries = await loadTranscriptTailEntries(
      '/nonexistent/sebiralph/missing.jsonl',
      { maxEntries: 10 },
    )
    expect(entries).toEqual([])
  })
})

describe('loadRecentAssistantTextEntries', () => {
  test('orders text entries oldest → newest and skips meta/sidechain rows', async () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        isSidechain: true,
        message: { content: [{ type: 'text', text: 'sidechain' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'older' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        isMeta: true,
        message: { content: [{ type: 'text', text: 'meta' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'newer' }] },
      }),
    ]
    await withTempFile(lines.join('\n') + '\n', async filePath => {
      const entries = await loadRecentAssistantTextEntries(filePath, {
        maxEntries: 5,
      })
      expect(entries.map(e => e.text)).toEqual(['older', 'newer'])
    })
  })
})
