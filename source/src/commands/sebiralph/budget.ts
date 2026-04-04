import type { SebiRalphRunState } from './types.js'

export function getEffectiveQualityLoopBudget(run: SebiRalphRunState): number {
  return run.workflow.maxQualityLoops + run.qualityLoopExtensions
}

export function getRemainingQualityLoopBudget(run: SebiRalphRunState): number {
  return Math.max(getEffectiveQualityLoopBudget(run) - run.qualityLoopsCompleted, 0)
}

