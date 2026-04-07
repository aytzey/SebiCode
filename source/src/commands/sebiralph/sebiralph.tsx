import type { UUID } from 'crypto'
import { getSessionId } from '../../bootstrap/state.js'
import type { AppState } from '../../state/AppStateStore.js'
import {
  DEFAULT_CONFIG,
  DEFAULT_WORKFLOW,
  LOOP_WORKFLOW,
} from '../../skills/sebiralph/types.js'
import { buildHarnessPrompt } from '../../skills/sebiralph/orchestrator.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { getLastSessionLog } from '../../utils/sessionStorage.js'

// SebiRalph orchestrator must always run on Claude Sonnet regardless of how
// the process was launched (sebi=Codex vs sebi-claude=Opus). Per-role workers,
// planner, evaluator, etc still pick their own provider via the Agent tool's
// `provider` field, so this only steers the main loop / orchestrator turns.
const ORCHESTRATOR_MODEL = 'sonnet'
const ORCHESTRATOR_PROVIDER: 'anthropic' | 'openai' = 'anthropic'

function pinOrchestratorRouting(
  setAppState: (updater: (prev: AppState) => AppState) => void,
): void {
  setAppState(prev => {
    if (
      prev.mainLoopModel === ORCHESTRATOR_MODEL &&
      prev.mainLoopProviderOverride === ORCHESTRATOR_PROVIDER
    ) {
      return prev
    }
    return {
      ...prev,
      mainLoopModel: ORCHESTRATOR_MODEL,
      mainLoopProviderOverride: ORCHESTRATOR_PROVIDER,
    }
  })
}
import {
  buildResumePrompt,
  formatRunSummary,
  shouldAutoContinueRun,
} from './prompt.js'
import {
  grantManualLoopExtension,
  shouldGrantManualLoopExtension,
  shouldReactivateLoopRun,
} from './reopen.js'
import {
  createSebiRalphRun,
  findSebiRalphRun,
  findReusableSebiRalphRun,
  saveSebiRalphRun,
} from './state.js'
import type { SebiRalphRunLookup, SebiRalphRunState } from './types.js'

async function extendCompletedLoopRun(
  lookup: SebiRalphRunLookup,
): Promise<SebiRalphRunLookup> {
  const nextRun = grantManualLoopExtension(lookup.run)
  await saveSebiRalphRun(nextRun)
  return {
    ...lookup,
    run: nextRun,
  }
}

async function resumeRunSession(
  lookup: SebiRalphRunLookup,
  context: Parameters<LocalJSXCommandCall>[1],
  onDone: Parameters<LocalJSXCommandCall>[0],
  options?: {
    manualLoopExtension?: boolean
    reactivatedLoop?: boolean
  },
): Promise<void> {
  const manualLoopExtension = options?.manualLoopExtension === true
  const reactivatedLoop = options?.reactivatedLoop === true
  const shouldQuery = manualLoopExtension || shouldAutoContinueRun(lookup.run)
  if (!context.resume) {
    onDone(
      `${formatRunSummary(lookup.run)}\n\nThis environment cannot resume saved sessions.`,
    )
    return
  }

  const fullLog = await getLastSessionLog(lookup.run.sessionId as UUID)
  if (!fullLog) {
    onDone(
      `${formatRunSummary(lookup.run)}\n\nThe saved session transcript could not be found.`,
    )
    return
  }

  try {
    await context.resume(
      lookup.run.sessionId as UUID,
      fullLog,
      'slash_command_session_id',
    )
    if (shouldQuery) {
      pinOrchestratorRouting(context.setAppState)
    }
    onDone(undefined, {
      display: 'skip',
      shouldQuery,
      metaMessages: shouldQuery
        ? [buildResumePrompt(lookup.run, { manualLoopExtension, reactivatedLoop })]
        : undefined,
    })
  } catch (error) {
    onDone(
      `Failed to resume SebiRalph run ${lookup.run.id.slice(0, 8)}: ${(error as Error).message}`,
    )
  }
}

async function continueExistingRun(
  lookup: SebiRalphRunLookup,
  context: Parameters<LocalJSXCommandCall>[1],
  onDone: Parameters<LocalJSXCommandCall>[0],
): Promise<null> {
  const manualLoopExtension = shouldGrantManualLoopExtension(lookup.run)
  const reactivatedLoop =
    manualLoopExtension && shouldReactivateLoopRun(lookup.run)
  const nextLookup = manualLoopExtension
    ? await extendCompletedLoopRun(lookup)
    : lookup

  if (nextLookup.run.sessionId !== getSessionId()) {
    await resumeRunSession(nextLookup, context, onDone, {
      manualLoopExtension,
      reactivatedLoop,
    })
    return null
  }

  const shouldQuery = manualLoopExtension || shouldAutoContinueRun(nextLookup.run)
  const intro = reactivatedLoop
    ? 'Reactivating the SebiRalph loop run with one additional refinement budget slot.'
    : manualLoopExtension
    ? 'Granting the SebiRalph loop run one additional refinement budget slot.'
    : 'Reusing existing SebiRalph run for this task.'
  if (shouldQuery) {
    pinOrchestratorRouting(context.setAppState)
  }
  onDone(`${intro}\n\n${formatRunSummary(nextLookup.run)}`, {
    shouldQuery,
    metaMessages: shouldQuery
      ? [
          buildResumePrompt(nextLookup.run, {
            manualLoopExtension,
            reactivatedLoop,
          }),
        ]
      : undefined,
  })
  return null
}

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const trimmed = args.trim()

  if (!trimmed) {
    const lookup = await findSebiRalphRun()
    if (!lookup) {
      onDone('No SebiRalph runs found. Start one with /sebiralph <task>.')
      return null
    }

    if (lookup.run.sessionId !== getSessionId()) {
      await resumeRunSession(lookup, context, onDone)
      return null
    }

    const shouldQuery = shouldAutoContinueRun(lookup.run)
    if (shouldQuery) {
      pinOrchestratorRouting(context.setAppState)
    }
    onDone(formatRunSummary(lookup.run), {
      shouldQuery,
      metaMessages: shouldQuery ? [buildResumePrompt(lookup.run)] : undefined,
    })
    return null
  }

  if (trimmed === 'resume' || trimmed.startsWith('resume ')) {
    const requestedRunId = trimmed.slice('resume '.length).trim()
    const lookup = await findSebiRalphRun(requestedRunId)
    if (!lookup) {
      onDone(`SebiRalph run "${requestedRunId}" was not found in this project.`)
      return null
    }

    if (lookup.run.sessionId !== getSessionId()) {
      await resumeRunSession(lookup, context, onDone)
      return null
    }

    const shouldQuery = shouldAutoContinueRun(lookup.run)
    if (shouldQuery) {
      pinOrchestratorRouting(context.setAppState)
    }
    onDone(formatRunSummary(lookup.run), {
      shouldQuery,
      metaMessages: shouldQuery ? [buildResumePrompt(lookup.run)] : undefined,
    })
    return null
  }

  if (trimmed === 'status' || trimmed.startsWith('status ')) {
    const requestedRunId = trimmed.slice('status'.length).trim()
    const lookup = await findSebiRalphRun(requestedRunId || undefined)
    if (!lookup) {
      onDone(
        requestedRunId
          ? `SebiRalph run "${requestedRunId}" was not found in this project.`
          : 'No SebiRalph runs found. Start one with /sebiralph <task>.',
      )
      return null
    }

    onDone(formatRunSummary(lookup.run))
    return null
  }

  if (trimmed === 'loop') {
    onDone('Use /sebiralph loop <task> to start an autonomous refinement loop.')
    return null
  }

  const launchMode = trimmed.startsWith('loop ') ? 'loop' : 'standard'
  const taskText =
    launchMode === 'loop' ? trimmed.slice('loop '.length).trim() : trimmed
  const workflow = launchMode === 'loop' ? LOOP_WORKFLOW : DEFAULT_WORKFLOW

  if (!taskText) {
    onDone('Provide a task after /sebiralph loop <task>.')
    return null
  }

  const existingRun = await findReusableSebiRalphRun({
    userTask: taskText,
    launchMode,
  })
  if (existingRun) {
    return continueExistingRun(existingRun, context, onDone)
  }

  const run = await createSebiRalphRun({
    userTask: taskText,
    config: DEFAULT_CONFIG,
    workflow,
    launchMode,
  })
  const harnessPrompt = buildHarnessPrompt(taskText, DEFAULT_CONFIG, workflow, {
    runId: run.id,
    sessionId: run.sessionId,
  })

  pinOrchestratorRouting(context.setAppState)
  onDone(formatRunSummary(run), {
    shouldQuery: true,
    metaMessages: [harnessPrompt],
  })

  return null
}
