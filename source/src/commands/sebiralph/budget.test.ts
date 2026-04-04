import { describe, expect, test } from 'bun:test'
import {
  getEffectiveQualityLoopBudget,
  getRemainingQualityLoopBudget,
} from './budget.js'
import type { SebiRalphRunState } from './types.js'

function makeRun(
  overrides: Partial<SebiRalphRunState> = {},
): SebiRalphRunState {
  return {
    id: 'run-1',
    sessionId: 'session-1',
    projectPath: '/tmp/project',
    userTask: 'build feature',
    createdAt: '2026-04-04T00:00:00.000Z',
    updatedAt: '2026-04-04T00:00:00.000Z',
    launchMode: 'loop',
    config: {} as SebiRalphRunState['config'],
    workflow: {
      tdd: true,
      deployVerification: true,
      loopMode: true,
      maxPlanIterations: 4,
      maxGateFixAttempts: 3,
      maxReviewFixCycles: 3,
      maxDeployFixCycles: 5,
      maxQualityLoops: 3,
    },
    executionPolicy: {
      fullAuto: true,
      tdd: true,
      deployVerification: true,
      loopMode: true,
      optionalRemotePush: true,
      maxPlanIterations: 4,
      maxGateFixAttempts: 3,
      maxReviewFixCycles: 3,
      maxDeployFixCycles: 5,
      maxQualityLoops: 3,
    },
    phase: 'completed',
    status: 'completed',
    taskRecords: [],
    waveRecords: [],
    deploy: {
      status: 'passed',
      fixCycles: 1,
    },
    qualityLoopsCompleted: 2,
    qualityLoopExtensions: 0,
    ...overrides,
  }
}

describe('sebiralph loop budget', () => {
  test('adds manual extensions on top of workflow max quality loops', () => {
    const run = makeRun({
      qualityLoopExtensions: 2,
    })

    expect(getEffectiveQualityLoopBudget(run)).toBe(5)
  })

  test('never returns a negative remaining quality loop budget', () => {
    const run = makeRun({
      qualityLoopExtensions: 1,
      qualityLoopsCompleted: 8,
    })

    expect(getRemainingQualityLoopBudget(run)).toBe(0)
  })
})

