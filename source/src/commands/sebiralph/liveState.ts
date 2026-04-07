import { readdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { getProjectDir } from '../../utils/sessionStoragePortable.js'
import { deriveRunHydrationFromTranscript } from './markers.js'
import type { SebiRalphTranscriptHydration } from './markers.js'
import { shouldKeepLoopRunOpen } from './reopen.js'
import type {
  SebiRalphRunLookup,
  SebiRalphRunState,
} from './types.js'

const RUNS_DIRNAME = 'sebiralph-runs'
const MARKER_HINT_RE =
  /<(?:sebiralph-progress|sebiralph-integration|sebiralph-deploy|sebiralph-loop)\b/i
const LEGACY_HINT_RE =
  /SebiRalph complete\.|Integration branch:\s*`|Deploy verification:\s*(?:PASS|FAIL|BLOCKED)/i

type PersistedAssistantEntry = {
  type: 'assistant'
  sessionId?: string
  cwd?: string
  timestamp?: string
  isApiErrorMessage?: boolean
  message?: {
    content?: unknown
  }
}

function getRunsDir(projectPath: string): string {
  return join(getPersistedProjectDir(projectPath), RUNS_DIRNAME)
}

function getRunPath(runId: string, projectPath: string): string {
  return join(getRunsDir(projectPath), `${runId}.json`)
}

export function getPersistedProjectDir(projectPath: string): string {
  return getProjectDir(projectPath)
}

export function getPersistedSebiRalphRunsDir(projectPath: string): string {
  return getRunsDir(projectPath)
}

function normalizeRun(run: SebiRalphRunState): SebiRalphRunState {
  run.workflow.loopMode ??= false
  run.workflow.maxQualityLoops ??= 0
  run.qualityLoopsCompleted ??= 0
  run.qualityLoopExtensions ??= 0
  if (!run.launchMode) {
    run.launchMode = run.workflow.loopMode ? 'loop' : 'standard'
  }
  if (run.executionPolicy.loopMode === undefined) {
    run.executionPolicy.loopMode = run.workflow.loopMode
  }
  if (run.executionPolicy.maxQualityLoops === undefined) {
    run.executionPolicy.maxQualityLoops = run.workflow.maxQualityLoops
  }
  return run
}

export async function loadPersistedSebiRalphRun(
  filePath: string,
): Promise<SebiRalphRunState | null> {
  try {
    const raw = await readFile(filePath, 'utf8')
    return normalizeRun(JSON.parse(raw) as SebiRalphRunState)
  } catch {
    return null
  }
}

export function applyRunHydration(
  run: SebiRalphRunState,
  hydration: SebiRalphTranscriptHydration,
): SebiRalphRunState {
  const next: SebiRalphRunState = {
    ...run,
    executionPolicy: { ...run.executionPolicy },
    taskRecords: [...run.taskRecords],
    waveRecords: [...run.waveRecords],
    deploy: { ...run.deploy },
  }

  if (hydration.updatedAt > next.updatedAt) {
    next.updatedAt = hydration.updatedAt
  }

  if (hydration.phase) {
    next.phase = hydration.phase
  }

  if (hydration.status) {
    next.status = hydration.status
  }

  if (hydration.lastProgressMarker) {
    next.lastProgressMarker = hydration.lastProgressMarker
  }

  if (hydration.completedAt) {
    next.completedAt ??= hydration.completedAt
  }

  if (hydration.integrationBranch) {
    next.integrationBranch = hydration.integrationBranch
  }

  if (hydration.lastError !== undefined) {
    if (hydration.lastError) {
      next.lastError = hydration.lastError
    } else {
      delete next.lastError
    }
  }

  if (hydration.deploy) {
    const nextDeploy = { ...next.deploy, ...hydration.deploy }
    if (hydration.deploy.status === 'blocked' && next.deploy.status === 'passed') {
      nextDeploy.status = 'passed'
    }
    next.deploy = nextDeploy
  }

  if (hydration.qualityLoopsCompleted !== undefined) {
    next.qualityLoopsCompleted = hydration.qualityLoopsCompleted
  }

  if (hydration.lastQualityVerdict !== undefined) {
    next.lastQualityVerdict = hydration.lastQualityVerdict
  }

  if (shouldKeepLoopRunOpen(next)) {
    next.phase = 'deploy_verify'
    next.status = 'active'
    delete next.completedAt
  }

  return next
}

export async function savePersistedSebiRalphRun(
  run: SebiRalphRunState,
): Promise<void> {
  await writeFile(
    getRunPath(run.id, run.projectPath),
    JSON.stringify(run, null, 2) + '\n',
    { encoding: 'utf8', mode: 0o600 },
  )
}

export async function findLatestSebiRalphRunForSession(
  projectPath: string,
  sessionId: string,
): Promise<SebiRalphRunLookup | null> {
  try {
    const dir = getRunsDir(projectPath)
    const entries = await readdir(dir, { withFileTypes: true })
    const runs = await Promise.all(
      entries
        .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
        .map(entry => loadPersistedSebiRalphRun(join(dir, entry.name))),
    )
    const matches = runs
      .filter((run): run is SebiRalphRunState => run !== null)
      .filter(run => run.sessionId === sessionId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

    if (matches.length === 0) {
      return null
    }

    return {
      run: matches[0]!,
      transcriptFound: true,
    }
  } catch {
    return null
  }
}

function getAssistantText(entry: PersistedAssistantEntry): string {
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

export async function syncSebiRalphRunStateFromTranscriptEntry(
  entry: PersistedAssistantEntry,
): Promise<void> {
  const projectPath = entry.cwd
  const sessionId = entry.sessionId
  if (!projectPath || !sessionId) {
    return
  }

  const text = getAssistantText(entry).trim()
  if (
    !text ||
    (!MARKER_HINT_RE.test(text) && !LEGACY_HINT_RE.test(text))
  ) {
    return
  }

  const lookup = await findLatestSebiRalphRunForSession(projectPath, sessionId)
  if (!lookup) {
    return
  }

  const hydration = deriveRunHydrationFromTranscript({
    runId: lookup.run.id,
    messages: [
      {
        text,
        isApiError: Boolean(entry.isApiErrorMessage),
      },
    ],
    modifiedAt: entry.timestamp ?? new Date().toISOString(),
  })
  const next = applyRunHydration(lookup.run, hydration)
  if (JSON.stringify(next) !== JSON.stringify(lookup.run)) {
    await savePersistedSebiRalphRun(next)
  }
}
