import { getRemainingQualityLoopBudget } from './budget.js'
import type { SebiRalphRunState } from './types.js'

export function shouldGrantManualLoopExtension(
  run: Pick<
    SebiRalphRunState,
    | 'launchMode'
    | 'status'
    | 'phase'
    | 'workflow'
    | 'qualityLoopsCompleted'
    | 'qualityLoopExtensions'
    | 'lastQualityVerdict'
  >,
): boolean {
  if (run.launchMode !== 'loop') {
    return false
  }

  if (run.status === 'completed' || run.phase === 'completed') {
    return true
  }

  if (run.lastQualityVerdict === 'limit_reached') {
    return true
  }

  return getRemainingQualityLoopBudget(run as SebiRalphRunState) === 0
}

export function shouldKeepLoopRunOpen(
  run: Pick<
    SebiRalphRunState,
    | 'launchMode'
    | 'status'
    | 'phase'
    | 'reopenRequestedAt'
    | 'completedAt'
    | 'lastQualityVerdict'
    | 'lastError'
  >,
): boolean {
  if (run.launchMode !== 'loop' || !run.reopenRequestedAt) {
    return false
  }

  if (run.status === 'completed' || run.phase === 'completed') {
    if (!run.completedAt) {
      return true
    }

    return run.reopenRequestedAt > run.completedAt
  }

  return run.lastQualityVerdict === 'limit_reached' && !run.lastError
}

export function shouldReactivateLoopRun(
  run: Pick<
    SebiRalphRunState,
    'status' | 'phase' | 'lastQualityVerdict'
  >,
): boolean {
  return (
    run.status === 'completed' ||
    run.phase === 'completed' ||
    run.lastQualityVerdict === 'limit_reached'
  )
}

export function grantManualLoopExtension(
  run: SebiRalphRunState,
  reopenedAt = new Date().toISOString(),
): SebiRalphRunState {
  const nextRun: SebiRalphRunState = {
    ...run,
    qualityLoopExtensions: run.qualityLoopExtensions + 1,
    reopenRequestedAt: reopenedAt,
    updatedAt: reopenedAt,
  }

  if (shouldReactivateLoopRun(run)) {
    nextRun.phase = 'deploy_verify'
    nextRun.status = 'active'
    nextRun.completedAt = undefined
  }

  return nextRun
}
