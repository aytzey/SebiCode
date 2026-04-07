import { randomUUID } from 'crypto'
import { mkdir, readdir, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import { getOriginalCwd, getSessionId } from '../../bootstrap/state.js'
import type {
  RalphConfig,
  RalphWorkflowDefaults,
} from '../../skills/sebiralph/types.js'
import { getProjectDir } from '../../utils/sessionStoragePortable.js'
import {
  applyRunHydration,
  loadPersistedSebiRalphRun,
} from './liveState.js'
import { deriveRunHydrationFromTranscript } from './markers.js'
import { selectReusableSebiRalphRun } from './selection.js'
import { loadRecentAssistantTextEntries } from './transcriptTail.js'
import type {
  SebiRalphExecutionPolicy,
  SebiRalphRunLookup,
  SebiRalphRunState,
} from './types.js'

const RUNS_DIRNAME = 'sebiralph-runs'

function getRunsDir(projectPath = getOriginalCwd()): string {
  return join(getProjectDir(projectPath), RUNS_DIRNAME)
}

function getRunPath(runId: string, projectPath = getOriginalCwd()): string {
  return join(getRunsDir(projectPath), `${runId}.json`)
}

function buildExecutionPolicy(
  workflow: RalphWorkflowDefaults,
): SebiRalphExecutionPolicy {
  return {
    fullAuto: true,
    tdd: workflow.tdd,
    deployVerification: workflow.deployVerification,
    loopMode: workflow.loopMode,
    optionalRemotePush: true,
    maxPlanIterations: workflow.maxPlanIterations,
    maxGateFixAttempts: workflow.maxGateFixAttempts,
    maxReviewFixCycles: workflow.maxReviewFixCycles,
    maxDeployFixCycles: workflow.maxDeployFixCycles,
    maxQualityLoops: workflow.maxQualityLoops,
  }
}

async function ensureRunsDir(projectPath = getOriginalCwd()): Promise<string> {
  const dir = getRunsDir(projectPath)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  return dir
}

async function loadRunFile(filePath: string): Promise<SebiRalphRunState | null> {
  return loadPersistedSebiRalphRun(filePath)
}

function getRunTranscriptPath(run: SebiRalphRunState): string {
  return join(getProjectDir(run.projectPath), `${run.sessionId}.jsonl`)
}

export async function saveSebiRalphRun(
  run: SebiRalphRunState,
): Promise<SebiRalphRunState> {
  await ensureRunsDir(run.projectPath)
  await writeFile(
    getRunPath(run.id, run.projectPath),
    JSON.stringify(run, null, 2) + '\n',
    { encoding: 'utf8', mode: 0o600 },
  )
  return run
}

export async function createSebiRalphRun(params: {
  userTask: string
  config: RalphConfig
  workflow: RalphWorkflowDefaults
  launchMode?: 'standard' | 'loop'
  projectPath?: string
  sessionId?: string
}): Promise<SebiRalphRunState> {
  const now = new Date().toISOString()
  const projectPath = params.projectPath ?? getOriginalCwd()
  const sessionId = params.sessionId ?? getSessionId()
  const run: SebiRalphRunState = {
    id: randomUUID(),
    sessionId,
    projectPath,
    userTask: params.userTask,
    createdAt: now,
    updatedAt: now,
    launchMode: params.launchMode ?? (params.workflow.loopMode ? 'loop' : 'standard'),
    config: params.config,
    workflow: params.workflow,
    executionPolicy: buildExecutionPolicy(params.workflow),
    phase: 'config_review',
    status: 'active',
    taskRecords: [],
    waveRecords: [],
    deploy: {
      status: 'unknown',
      fixCycles: 0,
    },
    qualityLoopsCompleted: 0,
    qualityLoopExtensions: 0,
  }
  return saveSebiRalphRun(run)
}

export async function listSebiRalphRuns(
  projectPath = getOriginalCwd(),
): Promise<SebiRalphRunState[]> {
  try {
    const dir = await ensureRunsDir(projectPath)
    const entries = await readdir(dir, { withFileTypes: true })
    const runs = await Promise.all(
      entries
        .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
        .map(entry => loadRunFile(join(dir, entry.name))),
    )
    return runs
      .filter((run): run is SebiRalphRunState => run !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  } catch {
    return []
  }
}

export async function hydrateSebiRalphRun(
  run: SebiRalphRunState,
): Promise<SebiRalphRunLookup> {
  const transcriptPath = getRunTranscriptPath(run)
  let modifiedAt: string
  try {
    const transcriptStat = await stat(transcriptPath)
    modifiedAt = transcriptStat.mtime.toISOString()
  } catch {
    return { run, transcriptFound: false }
  }

  // Tail-only read: never load the full session JSONL into memory just to
  // recover phase/deploy markers. The previous implementation called
  // getLastSessionLog which materialized the entire transcript (and 15 side
  // maps) for every run in parallel during findSebiRalphRun, which routinely
  // pushed the parent process past Node's 8 GB heap on long runs.
  const messages = await loadRecentAssistantTextEntries(transcriptPath, {
    maxEntries: 200,
  })
  if (messages.length === 0) {
    return { run, transcriptFound: false }
  }

  const hydration = deriveRunHydrationFromTranscript({
    runId: run.id,
    messages: messages.map(({ text, isApiError }) => ({ text, isApiError })),
    modifiedAt,
  })
  const next = applyRunHydration(run, hydration)

  if (JSON.stringify(next) !== JSON.stringify(run)) {
    await saveSebiRalphRun(next)
  }

  return { run: next, transcriptFound: true }
}

export async function findSebiRalphRun(
  runId?: string,
  projectPath = getOriginalCwd(),
): Promise<SebiRalphRunLookup | null> {
  const runs = await listSebiRalphRuns(projectPath)
  if (runs.length === 0) {
    return null
  }

  if (!runId) {
    const hydratedRuns = await Promise.all(runs.map(run => hydrateSebiRalphRun(run)))
    const preferred =
      hydratedRuns.find(lookup => lookup.run.status !== 'completed') ??
      [...hydratedRuns].sort((a, b) =>
        b.run.updatedAt.localeCompare(a.run.updatedAt),
      )[0]
    return preferred ?? null
  }

  const exact = runs.find(run => run.id === runId)
  if (exact) {
    return hydrateSebiRalphRun(exact)
  }

  const prefixMatches = runs.filter(run => run.id.startsWith(runId))
  if (prefixMatches.length === 1) {
    return hydrateSebiRalphRun(prefixMatches[0]!)
  }

  return null
}

export async function findReusableSebiRalphRun(
  options: {
    userTask: string
    launchMode: SebiRalphRunState['launchMode']
  },
  projectPath = getOriginalCwd(),
): Promise<SebiRalphRunLookup | null> {
  const runs = await listSebiRalphRuns(projectPath)
  if (runs.length === 0) {
    return null
  }

  const hydratedRuns = await Promise.all(runs.map(run => hydrateSebiRalphRun(run)))
  return (
    selectReusableSebiRalphRun(hydratedRuns, {
      ...options,
      currentSessionId: getSessionId(),
    }) ?? null
  )
}
