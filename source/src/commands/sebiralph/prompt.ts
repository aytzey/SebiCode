import {
  getEffectiveQualityLoopBudget,
  getRemainingQualityLoopBudget,
} from './budget.js'
import type { SebiRalphRunState } from './types.js'

export function formatPhase(phase: SebiRalphRunState['phase']): string {
  return phase.replace(/_/g, ' ')
}

export function isAutonomousPhase(phase: SebiRalphRunState['phase']): boolean {
  return (
    phase === 'explore' ||
    phase === 'plan' ||
    phase === 'evaluate' ||
    phase === 'wave_execution' ||
    phase === 'gate_validation' ||
    phase === 'review_fix' ||
    phase === 'integration_merge' ||
    phase === 'deploy_verify'
  )
}

export function shouldAutoContinueRun(run: SebiRalphRunState): boolean {
  if (run.phase === 'completed' || run.status === 'completed') {
    return false
  }

  if (run.launchMode === 'loop') {
    return true
  }

  return run.status === 'active'
}

export function shouldAutoContinueAutonomousRun(
  run: SebiRalphRunState,
): boolean {
  return run.status === 'active' && isAutonomousPhase(run.phase)
}

export function formatRunSummary(run: SebiRalphRunState): string {
  const deployStatus =
    run.deploy.status === 'unknown' ? 'not observed yet' : run.deploy.status
  const effectiveQualityLoopBudget = getEffectiveQualityLoopBudget(run)
  const remainingQualityLoops = getRemainingQualityLoopBudget(run)
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
    lines.push(`Quality loops base max: ${run.workflow.maxQualityLoops}`)
    lines.push(`Quality loop extensions: ${run.qualityLoopExtensions}`)
    lines.push(`Quality loops budget: ${effectiveQualityLoopBudget}`)
    lines.push(`Quality loops completed: ${run.qualityLoopsCompleted}`)
    lines.push(`Quality loops remaining: ${remainingQualityLoops}`)
    if (run.lastQualityVerdict) {
      lines.push(`Last quality verdict: ${run.lastQualityVerdict}`)
    }
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

export function buildResumePrompt(
  run: SebiRalphRunState,
  options?: {
    manualLoopExtension?: boolean
    reactivatedLoop?: boolean
  },
): string {
  const manualLoopExtension = options?.manualLoopExtension === true
  const reactivatedLoop = options?.reactivatedLoop === true
  const effectiveQualityLoopBudget = getEffectiveQualityLoopBudget(run)

  return [
    `Continue SebiRalph run ${run.id}.`,
    `Original task: ${run.userTask}`,
    `Launch mode: ${run.launchMode === 'loop' ? 'LOOP' : 'STANDARD'}.`,
    `Current inferred phase: ${run.phase}.`,
    `Current inferred status: ${run.status}.`,
    `TDD is ${run.workflow.tdd ? 'ON' : 'OFF'} for this run.`,
    run.launchMode === 'loop'
      ? `Loop mode is ON with an effective quality-loop budget of ${effectiveQualityLoopBudget}.`
      : 'Loop mode is OFF for this run.',
    run.launchMode === 'loop'
      ? `Observed quality loop usage so far: ${run.qualityLoopsCompleted}/${effectiveQualityLoopBudget}.`
      : 'No quality loop budget applies to this run.',
    run.launchMode === 'loop'
      ? `Explicit user-requested loop extensions recorded so far: ${run.qualityLoopExtensions}.`
      : 'No explicit loop extensions apply to this run.',
    run.launchMode === 'loop' && run.lastQualityVerdict
      ? `Latest recorded quality verdict: ${run.lastQualityVerdict}.`
      : 'No quality verdict has been recorded yet.',
    run.launchMode === 'loop'
      ? 'Loop checkpoints are pre-approved: do not stop for config review or PRD approval unless deploy input is missing or the user explicitly interrupts.'
      : 'Config review and PRD approval still require explicit user confirmation.',
    manualLoopExtension && reactivatedLoop
      ? 'The user explicitly re-ran the same loop command after the previous loop stopped. Re-activate the existing run instead of starting over from Phase 0, and treat this invocation as one newly granted refinement slot.'
      : manualLoopExtension
        ? 'The user explicitly re-ran the same loop command. Treat this invocation as one newly granted refinement slot on the current run.'
        : run.status === 'blocked'
          ? 'The run is currently blocked. Attempt recovery automatically if the blocker looks transient; only stop again if a true external blocker remains.'
          : 'Resume the run from its latest durable point.',
    run.integrationBranch
      ? `Reuse integration branch ${run.integrationBranch} unless a new branch is strictly required for safety.`
      : 'No prior integration branch has been observed yet.',
    run.deploy.status === 'passed'
      ? 'A deploy pass was already observed. Start from a fresh quality audit of the current integrated result, then refine, redeploy, and re-verify if gaps remain.'
      : `Latest deploy status: ${run.deploy.status}.`,
    run.deploy.url
      ? `Latest deploy URL: ${run.deploy.url}`
      : 'No deploy URL has been recorded yet.',
    run.launchMode === 'loop' &&
    run.qualityLoopsCompleted >= effectiveQualityLoopBudget
      ? 'The recorded loop budget is exhausted. Only stop if the remaining gaps are truly external blockers; otherwise justify any extra refinement round explicitly.'
      : 'Stay within the current effective quality-loop budget unless a new user instruction expands it again.',
    isAutonomousPhase(run.phase)
      ? 'You are resuming inside an autonomous internal phase. Do not end this turn with a status-only message. Immediately make the next tool call needed to advance the phase unless you hit a true blocker.'
      : 'If you are not at a hard stop, keep the harness moving without waiting for another nudge.',
    'Use the existing transcript state; do not restart from Phase 0 unless the user explicitly asks to reconfigure the run.',
    `Keep emitting progress markers with run_id="${run.id}".`,
    reactivatedLoop
      ? 'Treat the prior completion as a baseline snapshot and continue the loop with another high-bar refinement pass.'
      : run.phase === 'completed'
        ? 'The run is already complete. Summarize only if the user asks.'
        : 'Resume from the last unfinished phase and continue the harness.',
  ].join('\n')
}
