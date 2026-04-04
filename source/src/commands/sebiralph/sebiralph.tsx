import type { UUID } from 'crypto'
import { getSessionId } from '../../bootstrap/state.js'
import {
  DEFAULT_CONFIG,
  DEFAULT_WORKFLOW,
  LOOP_WORKFLOW,
} from '../../skills/sebiralph/types.js'
import { buildHarnessPrompt } from '../../skills/sebiralph/orchestrator.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { getLastSessionLog } from '../../utils/sessionStorage.js'
import {
  createSebiRalphRun,
  findSebiRalphRun,
  findReusableSebiRalphRun,
} from './state.js'
import type { SebiRalphRunLookup, SebiRalphRunState } from './types.js'

function formatPhase(phase: SebiRalphRunState['phase']): string {
  return phase.replace(/_/g, ' ')
}

function shouldAutoContinueRun(run: SebiRalphRunState): boolean {
  if (run.phase === 'completed' || run.status === 'completed') {
    return false
  }

  if (run.launchMode === 'loop') {
    return true
  }

  return run.status === 'active'
}

function shouldReopenCompletedLoopRun(run: SebiRalphRunState): boolean {
  return run.launchMode === 'loop' && run.status === 'completed'
}

function formatRunSummary(run: SebiRalphRunState): string {
  const deployStatus =
    run.deploy.status === 'unknown' ? 'not observed yet' : run.deploy.status
  const lines = [
    `SebiRalph run ${run.id.slice(0, 8)}`,
    `Mode: ${run.launchMode === 'loop' ? 'loop' : 'standard'}`,
    `Task: ${run.userTask}`,
    `Status: ${run.status}`,
    `Phase: ${formatPhase(run.phase)}`,
    `TDD: ${run.workflow.tdd ? 'on' : 'off'}`,
    `Deploy verification: ${run.workflow.deployVerification ? 'required' : 'optional'}`,
    `Deploy status: ${deployStatus}`,
    `Session: ${run.sessionId}`,
  ]

  if (run.launchMode === 'loop') {
    lines.push(`Quality loops max: ${run.workflow.maxQualityLoops}`)
  }

  if (run.integrationBranch) {
    lines.push(`Integration branch: ${run.integrationBranch}`)
  }

  if (run.deploy.target) {
    lines.push(`Deploy target: ${run.deploy.target}`)
  }

  if (run.deploy.url) {
    lines.push(`Deploy URL: ${run.deploy.url}`)
  }

  if (run.lastError) {
    lines.push(`Last error: ${run.lastError}`)
  }

  return lines.join('\n')
}

function buildResumePrompt(
  run: SebiRalphRunState,
  options?: {
    reopenCompletedLoop?: boolean
  },
): string {
  const reopenCompletedLoop = options?.reopenCompletedLoop === true

  return [
    `Continue SebiRalph run ${run.id}.`,
    `Original task: ${run.userTask}`,
    `Launch mode: ${run.launchMode === 'loop' ? 'LOOP' : 'STANDARD'}.`,
    `Current inferred phase: ${run.phase}.`,
    `Current inferred status: ${run.status}.`,
    `TDD is ${run.workflow.tdd ? 'ON' : 'OFF'} for this run.`,
    run.launchMode === 'loop'
      ? `Loop mode is ON with up to ${run.workflow.maxQualityLoops} post-deploy refinement loops.`
      : 'Loop mode is OFF for this run.',
    run.launchMode === 'loop'
      ? 'Loop checkpoints are pre-approved: do not stop for config review or PRD approval unless deploy input is missing or the user explicitly interrupts.'
      : 'Config review and PRD approval still require explicit user confirmation.',
    reopenCompletedLoop
      ? 'The user explicitly re-ran the same loop command after a completed run. Re-open the existing run instead of starting over from Phase 0.'
      : run.status === 'blocked'
      ? 'The run is currently blocked. Attempt recovery automatically if the blocker looks transient; only stop again if a true external blocker remains.'
      : 'Resume the run from its latest durable point.',
    run.integrationBranch
      ? `Reuse integration branch ${run.integrationBranch} unless a new branch is strictly required for safety.`
      : 'No prior integration branch has been observed yet.',
    run.deploy.status === 'passed'
      ? 'A deploy pass was already observed. Start from a fresh quality audit of the current integrated result, then refine, redeploy, and re-verify if gaps remain.'
      : `Latest deploy status: ${run.deploy.status}.`,
    run.deploy.url ? `Latest deploy URL: ${run.deploy.url}` : 'No deploy URL has been recorded yet.',
    'Use the existing transcript state; do not restart from Phase 0 unless the user explicitly asks to reconfigure the run.',
    `Keep emitting progress markers with run_id="${run.id}".`,
    reopenCompletedLoop
      ? 'Treat the prior completion as a baseline snapshot and continue the loop with another high-bar refinement pass.'
      : run.phase === 'completed'
      ? 'The run is already complete. Summarize only if the user asks.'
      : 'Resume from the last unfinished phase and continue the harness.',
  ].join('\n')
}

async function resumeRunSession(
  lookup: SebiRalphRunLookup,
  context: Parameters<LocalJSXCommandCall>[1],
  onDone: Parameters<LocalJSXCommandCall>[0],
  options?: {
    reopenCompletedLoop?: boolean
  },
): Promise<void> {
  const reopenCompletedLoop = options?.reopenCompletedLoop === true
  const shouldQuery = reopenCompletedLoop || shouldAutoContinueRun(lookup.run)
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
    onDone(undefined, {
      display: 'skip',
      shouldQuery,
      metaMessages: shouldQuery
        ? [buildResumePrompt(lookup.run, { reopenCompletedLoop })]
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
  const reopenCompletedLoop = shouldReopenCompletedLoopRun(lookup.run)
  if (lookup.run.sessionId !== getSessionId()) {
    await resumeRunSession(lookup, context, onDone, { reopenCompletedLoop })
    return null
  }

  const shouldQuery = reopenCompletedLoop || shouldAutoContinueRun(lookup.run)
  const intro = reopenCompletedLoop
    ? 'Reopening completed SebiRalph loop run for another refinement pass.'
    : 'Reusing existing SebiRalph run for this task.'
  onDone(`${intro}\n\n${formatRunSummary(lookup.run)}`, {
    shouldQuery,
    metaMessages: shouldQuery
      ? [buildResumePrompt(lookup.run, { reopenCompletedLoop })]
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

  onDone(formatRunSummary(run), {
    shouldQuery: true,
    metaMessages: [harnessPrompt],
  })

  return null
}
