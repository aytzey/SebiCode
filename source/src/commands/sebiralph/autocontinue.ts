import { join } from 'path'
import { buildResumePrompt, shouldAutoContinueAutonomousRun } from './prompt.js'
import { getPersistedProjectDir } from './liveState.js'
import { findLatestSebiRalphRunForSession } from './liveState.js'
import { loadTranscriptTailEntries } from './transcriptTail.js'

export const SEBIRALPH_AUTO_CONTINUE_BUDGET = 12
const AUTO_CONTINUE_LOOKBACK_ENTRY_COUNT = 16
const GENERIC_STATUS_UPDATE_MAX_CHARS = 1400
const GENERIC_STATUS_PROGRESS_HINTS = [
  /\bplan aşamasındayım\b/i,
  /\bşu an\b/i,
  /\bşimdi\b/i,
  /\bbirazdan\b/i,
  /\bdevam ediyorum\b/i,
  /\bplan yazımındayım\b/i,
  /\bimplementation planning\b/i,
  /\btransitioning to\b/i,
  /\brevising\b/i,
  /\bextracting\b/i,
  /\bsearching for\b/i,
  /\breading\b/i,
  /\bexploring\b/i,
  /\bgathering\b/i,
  /\bpinning down\b/i,
  /\bi('| a)?m (currently|still|now|using|working|extracting|gathering|reading|searching|revising)\b/i,
  /\bi('| wi)ll (now|next)\b/i,
]
const GENERIC_STATUS_BLOCKERS = [
  /\?/,
  /\bblocked\b/i,
  /\bblocker\b/i,
  /\bneed user\b/i,
  /\bneed your\b/i,
  /\bonay\b/i,
  /\bapprove\b/i,
  /\bchoose\b/i,
  /\bwhich one\b/i,
  /\bhangi\b/i,
  /\bizin\b/i,
  /\bbekliyorum\b/i,
  /\bawaiting\b/i,
]
const GENERIC_STATUS_COMPLETION_HINTS = [
  /\bdone\b/i,
  /\bcompleted\b/i,
  /\bfinished\b/i,
  /\bimplemented\b/i,
  /\bfixed\b/i,
  /\bwrote\b/i,
  /\bsaved\b/i,
  /\btests? passed\b/i,
  /\bişte\b/i,
  /\bkaydettim\b/i,
  /\byazdım\b/i,
]

type PersistedTranscriptEntry = {
  type?: string
  isMeta?: boolean
  isSidechain?: boolean
  message?: {
    content?: unknown
    stop_reason?: string
  }
}

function isMeaningfulMainEntry(entry: PersistedTranscriptEntry): boolean {
  if (entry.isSidechain || entry.isMeta) {
    return false
  }
  return entry.type === 'assistant' || entry.type === 'user'
}

function isToolResultUserEntry(entry: PersistedTranscriptEntry): boolean {
  if (entry.type !== 'user') {
    return false
  }
  if (typeof entry.message?.content === 'string') {
    return false
  }
  return Array.isArray(entry.message?.content)
    ? entry.message!.content.some(
        block =>
          typeof block === 'object' &&
          block !== null &&
          'type' in block &&
          block.type === 'tool_result',
      )
    : false
}

function hasToolUse(entry: PersistedTranscriptEntry): boolean {
  return Array.isArray(entry.message?.content)
    ? entry.message!.content.some(
        block =>
          typeof block === 'object' &&
          block !== null &&
          'type' in block &&
          block.type === 'tool_use',
      )
    : false
}

function getAssistantText(entry: PersistedTranscriptEntry): string {
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

function hasAnyToolUse(entry: PersistedTranscriptEntry): boolean {
  return Array.isArray(entry.message?.content)
    ? entry.message!.content.some(
        block =>
          typeof block === 'object' &&
          block !== null &&
          'type' in block &&
          block.type === 'tool_use',
      )
    : false
}

function isLikelyGenericStatusUpdate(text: string): boolean {
  const normalized = text.trim()
  if (!normalized || normalized.length > GENERIC_STATUS_UPDATE_MAX_CHARS) {
    return false
  }
  if (hasGenericStatusBlocker(normalized)) {
    return false
  }
  if (GENERIC_STATUS_COMPLETION_HINTS.some(pattern => pattern.test(normalized))) {
    return false
  }
  return GENERIC_STATUS_PROGRESS_HINTS.some(pattern => pattern.test(normalized))
}

function hasGenericStatusBlocker(
  text: string,
  options?: { ignoreQuestionMark?: boolean },
): boolean {
  return GENERIC_STATUS_BLOCKERS.some(pattern => {
    if (options?.ignoreQuestionMark && pattern.source === '\\?') {
      return false
    }
    return pattern.test(text)
  })
}

async function loadLatestMainTranscriptEntries(
  projectPath: string,
  sessionId: string,
  count = 2,
): Promise<PersistedTranscriptEntry[]> {
  const transcriptPath = join(
    getPersistedProjectDir(projectPath),
    `${sessionId}.jsonl`,
  )
  // Bounded tail read: at most `count` matching entries OR ~4 MB of file tail,
  // whichever comes first. This replaces a doubling-buffer scan that could
  // allocate hundreds of MB per call on long sessions.
  const entries = await loadTranscriptTailEntries(transcriptPath, {
    maxEntries: count,
    filter: entry => isMeaningfulMainEntry(entry as PersistedTranscriptEntry),
  })
  return entries as PersistedTranscriptEntry[]
}

function getTranscriptTailContext(entries: PersistedTranscriptEntry[]): {
  latestEntry: PersistedTranscriptEntry | undefined
  trailingToolResultEntries: PersistedTranscriptEntry[]
  precedingAssistantEntry: PersistedTranscriptEntry | undefined
} {
  const latestEntry = entries[0]
  const trailingToolResultEntries: PersistedTranscriptEntry[] = []

  for (const entry of entries) {
    if (!isToolResultUserEntry(entry)) {
      break
    }
    trailingToolResultEntries.push(entry)
  }

  const precedingAssistantCandidate = entries[trailingToolResultEntries.length]

  return {
    latestEntry,
    trailingToolResultEntries,
    precedingAssistantEntry:
      precedingAssistantCandidate?.type === 'assistant'
        ? precedingAssistantCandidate
        : undefined,
  }
}

function buildGenericAutoContinuePrompt(
  entries: PersistedTranscriptEntry[],
): string | null {
  const {
    latestEntry,
    trailingToolResultEntries,
    precedingAssistantEntry,
  } = getTranscriptTailContext(entries)
  const latestAssistantText =
    latestEntry?.type === 'assistant' && !hasToolUse(latestEntry)
      ? getAssistantText(latestEntry)
      : ''
  // Path 1: text-only assistant message that looks like a progress status
  const canContinueFromStatusOnlyAssistant =
    latestEntry?.type === 'assistant' &&
    !hasToolUse(latestEntry) &&
    isLikelyGenericStatusUpdate(latestAssistantText)
  // Path 2: pending tool result batch waiting for model to process
  const canContinueFromUnresolvedToolResult =
    trailingToolResultEntries.length > 0 &&
    precedingAssistantEntry !== undefined &&
    hasAnyToolUse(precedingAssistantEntry)
  // Path 3: assistant was actively working (had tool calls) and hasn't
  // signalled completion — continue even if text contains a question mark.
  // This handles mid-workflow pauses where the model asks an optional
  // question alongside tool calls (e.g. brainstorming creating tasks then
  // asking "want to try visual mode?").
  const assistantTextFromActiveTurn =
    latestEntry?.type === 'assistant' && hasAnyToolUse(latestEntry)
      ? getAssistantText(latestEntry).trim()
      : ''
  const canContinueFromActiveTurn =
    latestEntry?.type === 'assistant' &&
    hasAnyToolUse(latestEntry) &&
    assistantTextFromActiveTurn.length < GENERIC_STATUS_UPDATE_MAX_CHARS &&
    !hasGenericStatusBlocker(assistantTextFromActiveTurn, {
      ignoreQuestionMark: true,
    }) &&
    !GENERIC_STATUS_COMPLETION_HINTS.some(pattern => pattern.test(assistantTextFromActiveTurn))

  if (
    !canContinueFromStatusOnlyAssistant &&
    !canContinueFromUnresolvedToolResult &&
    !canContinueFromActiveTurn
  ) {
    return null
  }

  if (canContinueFromActiveTurn) {
    return [
      'Automatic keep-alive continuation.',
      'Your previous turn ended while you were actively working (you had tool calls in progress).',
      'Do NOT stop to ask the user optional questions — continue immediately with the next step.',
      'If you have pending tasks or open work items, keep executing them.',
      'Only pause if there is a critical blocker that cannot be resolved from context.',
    ].join('\n\n')
  }

  return [
    'Automatic keep-alive continuation.',
    'Your previous turn ended while you were still working on the user request.',
    'Do not send another progress-only update.',
    'Continue immediately by making the next tool call or by producing the actual deliverable.',
    'Only ask the user a question if there is a real blocker that cannot be resolved from local context.',
  ].join('\n\n')
}

export async function maybeBuildSebiRalphAutoContinuePrompt(
  projectPath: string,
  sessionId: string,
): Promise<string | null> {
  const lookup = await findLatestSebiRalphRunForSession(projectPath, sessionId)
  if (!lookup || !shouldAutoContinueAutonomousRun(lookup.run)) {
    return null
  }

  const entries = await loadLatestMainTranscriptEntries(
    projectPath,
    sessionId,
    AUTO_CONTINUE_LOOKBACK_ENTRY_COUNT,
  )
  const {
    latestEntry,
    trailingToolResultEntries,
    precedingAssistantEntry,
  } = getTranscriptTailContext(entries)
  const canContinueFromAssistantText =
    latestEntry?.type === 'assistant' &&
    !hasToolUse(latestEntry) &&
    getAssistantText(latestEntry).trim().length > 0
  const canContinueFromToolResultBatch =
    trailingToolResultEntries.length > 0 &&
    precedingAssistantEntry !== undefined &&
    hasAnyToolUse(precedingAssistantEntry)

  if (!canContinueFromAssistantText && !canContinueFromToolResultBatch) {
    return null
  }

  return [
    `Automatic SebiRalph keep-alive continuation for run ${lookup.run.id}.`,
    'The previous turn ended while the harness was still inside an autonomous internal phase.',
    buildResumePrompt(lookup.run),
    'Do not emit another status-only update. Immediately make the next tool call needed to advance the run unless a true blocker exists.',
  ].join('\n\n')
}

export async function maybeBuildAutoContinuePrompt(
  projectPath: string,
  sessionId: string,
): Promise<string | null> {
  const sebiRalphPrompt = await maybeBuildSebiRalphAutoContinuePrompt(
    projectPath,
    sessionId,
  )
  if (sebiRalphPrompt) {
    return sebiRalphPrompt
  }

  const entries = await loadLatestMainTranscriptEntries(
    projectPath,
    sessionId,
    AUTO_CONTINUE_LOOKBACK_ENTRY_COUNT,
  )
  return buildGenericAutoContinuePrompt(entries)
}
