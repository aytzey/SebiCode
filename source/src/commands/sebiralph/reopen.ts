import type { SebiRalphRunState } from './types.js'

export function shouldKeepLoopRunOpen(
  run: Pick<
    SebiRalphRunState,
    'launchMode' | 'status' | 'phase' | 'reopenRequestedAt' | 'completedAt'
  >,
): boolean {
  if (run.launchMode !== 'loop' || !run.reopenRequestedAt) {
    return false
  }

  if (run.status !== 'completed' && run.phase !== 'completed') {
    return false
  }

  if (!run.completedAt) {
    return true
  }

  return run.reopenRequestedAt > run.completedAt
}

export function reopenCompletedLoopRun(
  run: SebiRalphRunState,
  reopenedAt = new Date().toISOString(),
): SebiRalphRunState {
  return {
    ...run,
    phase: 'deploy_verify',
    status: 'active',
    qualityLoopExtensions: run.qualityLoopExtensions + 1,
    reopenRequestedAt: reopenedAt,
    completedAt: undefined,
    updatedAt: reopenedAt,
  }
}

