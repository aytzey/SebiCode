import { open } from 'fs/promises'

/**
 * Bounded JSONL tail reader for SebiRalph harness state.
 *
 * Both the slash-command run hydration path and the auto-continue keep-alive
 * path only ever need a small window of recent transcript entries. The Claude
 * Code session JSONL files can grow to hundreds of megabytes during long
 * /sebiralph runs, and naïvely loading the whole file (`getLastSessionLog`)
 * or doubling a buffer up to file size (the previous autocontinue tail
 * reader) caused the parent process to blow past the 8 GB heap limit.
 *
 * This helper:
 *  - reads the file from the end backward in fixed 64 KB chunks,
 *  - parses each chunk's lines, keeping at most `maxEntries` newest-first
 *    matching entries,
 *  - bounds total bytes read by `maxBytes` (default 4 MB) regardless of how
 *    large the file is,
 *  - never materializes the full file in memory.
 *
 * Returned entries are sorted **newest first** (index 0 = most recent).
 */

export type RawTranscriptEntry = {
  type?: string
  isMeta?: boolean
  isSidechain?: boolean
  timestamp?: string
  isApiErrorMessage?: boolean
  message?: {
    content?: unknown
    stop_reason?: string
  }
}

export type TranscriptTailOptions = {
  maxEntries?: number
  maxBytes?: number
  filter?: (entry: RawTranscriptEntry) => boolean
}

const DEFAULT_MAX_ENTRIES = 16
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024
const READ_CHUNK_BYTES = 64 * 1024

/**
 * Read the tail of a JSONL transcript file and return at most `maxEntries`
 * matching entries, newest first. Bounded both by entry count and byte count
 * so callers can rely on flat memory regardless of file size.
 */
export async function loadTranscriptTailEntries(
  filePath: string,
  options: TranscriptTailOptions = {},
): Promise<RawTranscriptEntry[]> {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const filter = options.filter

  if (maxEntries <= 0) {
    return []
  }

  let file: Awaited<ReturnType<typeof open>> | undefined
  try {
    file = await open(filePath, 'r')
    const { size } = await file.stat()
    if (size <= 0) {
      return []
    }

    // Newest-first accumulator. We never store more than `maxEntries`.
    const collected: RawTranscriptEntry[] = []
    // Pending bytes from the previous (older) read that did not begin a full
    // line — we stitch them onto the next chunk so we don't lose entries that
    // span chunk boundaries.
    let pendingPrefix = ''
    let bytesRead = 0
    let cursor = size

    while (cursor > 0 && bytesRead < maxBytes && collected.length < maxEntries) {
      const chunkLen = Math.min(READ_CHUNK_BYTES, cursor, maxBytes - bytesRead)
      if (chunkLen <= 0) {
        break
      }
      const start = cursor - chunkLen
      const buffer = Buffer.alloc(chunkLen)
      await file.read(buffer, 0, chunkLen, start)
      bytesRead += chunkLen
      cursor = start

      // Stitch this chunk onto whatever leftover bytes we had from the
      // previous (older) iteration. We're walking backward, so the leftover
      // sits at the END of the new chunk.
      const text = buffer.toString('utf8') + pendingPrefix
      const lines = text.split('\n')

      // The first line of `lines` may be a partial line (the rest of it is
      // earlier in the file, in a chunk we have not read yet). Defer it
      // unless we are now at offset 0 — at which point it is a full line.
      let firstLineStart = 0
      if (cursor > 0) {
        pendingPrefix = lines[0] ?? ''
        firstLineStart = 1
      } else {
        pendingPrefix = ''
      }

      // Walk newest → oldest within the chunk.
      for (let i = lines.length - 1; i >= firstLineStart; i -= 1) {
        const line = lines[i]
        if (!line) continue
        const trimmed = line.trim()
        if (!trimmed) continue
        let parsed: RawTranscriptEntry | null = null
        try {
          parsed = JSON.parse(trimmed) as RawTranscriptEntry
        } catch {
          continue
        }
        if (filter && !filter(parsed)) {
          continue
        }
        collected.push(parsed)
        if (collected.length >= maxEntries) {
          return collected
        }
      }
    }

    return collected
  } catch {
    return []
  } finally {
    await file?.close()
  }
}

/**
 * Convenience wrapper: pull the most recent assistant entries with text
 * content. Used by SebiRalph run hydration to recover phase/deploy markers
 * without loading the entire session transcript.
 */
export async function loadRecentAssistantTextEntries(
  filePath: string,
  options: { maxEntries?: number; maxBytes?: number } = {},
): Promise<{ text: string; isApiError: boolean; timestamp?: string }[]> {
  const entries = await loadTranscriptTailEntries(filePath, {
    maxEntries: options.maxEntries ?? 200,
    maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
    filter: entry =>
      entry.type === 'assistant' && !entry.isSidechain && !entry.isMeta,
  })

  // Caller iterates oldest → newest, so reverse the newest-first accumulator.
  const ordered: { text: string; isApiError: boolean; timestamp?: string }[] = []
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]!
    const text = extractAssistantText(entry)
    if (!text) continue
    ordered.push({
      text,
      isApiError: Boolean(entry.isApiErrorMessage),
      timestamp: entry.timestamp,
    })
  }
  return ordered
}

function extractAssistantText(entry: RawTranscriptEntry): string {
  const content = entry.message?.content
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return ''
  }
  return content
    .filter(
      (block): block is { type: 'text'; text: string } =>
        typeof block === 'object' &&
        block !== null &&
        'type' in block &&
        'text' in block &&
        block.type === 'text' &&
        typeof block.text === 'string',
    )
    .map(block => block.text)
    .join('\n')
}
