import type { UUID } from 'crypto'
import { getSessionId } from '../../bootstrap/state.js'
import { DEFAULT_CONFIG, DEFAULT_WORKFLOW } from '../../skills/sebiralph/types.js'
import { buildHarnessPrompt } from '../../skills/sebiralph/orchestrator.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { getLastSessionLog } from '../../utils/sessionStorage.js'
import {
  createSebiRalphRun,
  findSebiRalphRun,
} from './state.js'
import type { SebiRalphRunLookup, SebiRalphRunState } from './types.js'

function formatPhase(phase: SebiRalphRunState['phase']): string {
  return phase.replace(/_/g, ' ')
}

function formatRunSummary(run: SebiRalphRunState): string {
  const deployStatus =
    run.deploy.status === 'unknown' ? 'not observed yet' : run.deploy.status
  const lines = [
    `SebiRalph run ${run.id.slice(0, 8)}`,
    `Task: ${run.userTask}`,
    `Status: ${run.status}`,
    `Phase: ${formatPhase(run.phase)}`,
    `TDD: ${run.workflow.tdd ? 'on' : 'off'}`,
    `Deploy verification: ${run.workflow.deployVerification ? 'required' : 'optional'}`,
    `Deploy status: ${deployStatus}`,
    `Session: ${run.sessionId}`,
  ]

  if (run.integrationBranch) {
    lines.push(`Integration branch: ${run.integrationBranch}`)
  }

  return lines.join('\n')
}

function buildResumePrompt(run: SebiRalphRunState): string {
  return [
    `Continue SebiRalph run ${run.id}.`,
    `Original task: ${run.userTask}`,
    `Current inferred phase: ${run.phase}.`,
    `Current inferred status: ${run.status}.`,
    `TDD is ${run.workflow.tdd ? 'ON' : 'OFF'} for this run.`,
    'Use the existing transcript state; do not restart from Phase 0 unless the user explicitly asks to reconfigure the run.',
    `Keep emitting progress markers with run_id="${run.id}".`,
    run.phase === 'completed'
      ? 'The run is already complete. Summarize only if the user asks.'
      : 'Resume from the last unfinished phase and continue the harness.',
  ].join('\n')
}

async function resumeRunSession(
  lookup: SebiRalphRunLookup,
  context: Parameters<LocalJSXCommandCall>[1],
  onDone: Parameters<LocalJSXCommandCall>[0],
): Promise<void> {
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
    onDone(undefined, { display: 'skip' })
  } catch (error) {
    onDone(
      `Failed to resume SebiRalph run ${lookup.run.id.slice(0, 8)}: ${(error as Error).message}`,
    )
  }
}

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const trimmed = args.trim()

  if (!trimmed || trimmed === 'resume') {
    const lookup = await findSebiRalphRun()
    if (!lookup) {
      onDone('No SebiRalph runs found. Start one with /sebiralph <task>.')
      return null
    }

    if (lookup.run.sessionId !== getSessionId()) {
      await resumeRunSession(lookup, context, onDone)
      return null
    }

    const shouldQuery =
      lookup.run.status === 'active' && lookup.run.phase !== 'completed'
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

    const shouldQuery =
      lookup.run.status === 'active' && lookup.run.phase !== 'completed'
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

  const run = await createSebiRalphRun({
    userTask: trimmed,
    config: DEFAULT_CONFIG,
    workflow: DEFAULT_WORKFLOW,
  })
  const harnessPrompt = buildHarnessPrompt(trimmed, DEFAULT_CONFIG, DEFAULT_WORKFLOW, {
    runId: run.id,
    sessionId: run.sessionId,
  })

  onDone(formatRunSummary(run), {
    shouldQuery: true,
    metaMessages: [harnessPrompt],
  })

  return null
}
