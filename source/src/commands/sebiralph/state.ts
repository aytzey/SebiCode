import { randomUUID, type UUID } from 'crypto'
import { mkdir, readFile, readdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { getOriginalCwd, getSessionId } from '../../bootstrap/state.js'
import type {
  RalphConfig,
  RalphWorkflowDefaults,
} from '../../skills/sebiralph/types.js'
import type { LogOption } from '../../types/logs.js'
import { getLastSessionLog } from '../../utils/sessionStorage.js'
import { getProjectDir } from '../../utils/sessionStoragePortable.js'
import { deriveRunHydrationFromTranscript } from './markers.js'
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
    optionalRemotePush: true,
    maxPlanIterations: workflow.maxPlanIterations,
    maxGateFixAttempts: workflow.maxGateFixAttempts,
    maxReviewFixCycles: workflow.maxReviewFixCycles,
    maxDeployFixCycles: workflow.maxDeployFixCycles,
  }
}

async function ensureRunsDir(projectPath = getOriginalCwd()): Promise<string> {
  const dir = getRunsDir(projectPath)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  return dir
}

function getMessageText(message: LogOption['messages'][number]): string {
  const content = (message as { message?: { content?: unknown } }).message?.content
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return ''
  }
  return content
    .filter(
      (block): block is { type: 'text'; text: string } =>
        block.type === 'text' && typeof block.text === 'string',
    )
    .map(block => block.text)
    .join('\n')
}

function isApiErrorMessage(message: LogOption['messages'][number]): boolean {
  return Boolean(
    (message as { isApiErrorMessage?: boolean }).isApiErrorMessage ||
      (message as { error?: string }).error,
  )
}

function cloneRun(run: SebiRalphRunState): SebiRalphRunState {
  return {
    ...run,
    executionPolicy: { ...run.executionPolicy },
    taskRecords: [...run.taskRecords],
    waveRecords: [...run.waveRecords],
    deploy: { ...run.deploy },
  }
}

async function loadRunFile(filePath: string): Promise<SebiRalphRunState | null> {
  try {
    const raw = await readFile(filePath, 'utf8')
    return JSON.parse(raw) as SebiRalphRunState
  } catch {
    return null
  }
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
  const log = await getLastSessionLog(run.sessionId as UUID)
  if (!log) {
    return { run, transcriptFound: false }
  }

  const next = cloneRun(run)
  const assistantMessages = log.messages.filter(message => message.type === 'assistant')
  const hydration = deriveRunHydrationFromTranscript({
    runId: run.id,
    messages: assistantMessages.map(message => ({
      text: getMessageText(message),
      isApiError: isApiErrorMessage(message),
    })),
    modifiedAt: log.modified.toISOString(),
  })

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
