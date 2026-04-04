import { describe, expect, test } from 'bun:test'
import { reopenCompletedLoopRun, shouldKeepLoopRunOpen } from './reopen.js'
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
    qualityLoopsCompleted: 3,
    qualityLoopExtensions: 0,
    completedAt: '2026-04-04T01:00:00.000Z',
    ...overrides,
  }
}

describe('sebiralph reopen helpers', () => {
  test('reopenCompletedLoopRun marks the run active and increments the extension budget', () => {
    const reopened = reopenCompletedLoopRun(
      makeRun(),
      '2026-04-04T01:05:00.000Z',
    )

    expect(reopened.phase).toBe('deploy_verify')
    expect(reopened.status).toBe('active')
    expect(reopened.qualityLoopExtensions).toBe(1)
    expect(reopened.reopenRequestedAt).toBe('2026-04-04T01:05:00.000Z')
    expect(reopened.completedAt).toBeUndefined()
  })

  test('shouldKeepLoopRunOpen keeps a loop run active when reopen is newer than completion', () => {
    const reopened = makeRun({
      reopenRequestedAt: '2026-04-04T01:05:00.000Z',
    })

    expect(shouldKeepLoopRunOpen(reopened)).toBe(true)
  })

  test('shouldKeepLoopRunOpen does not override newer non-completed state', () => {
    const run = makeRun({
      phase: 'blocked',
      status: 'blocked',
      reopenRequestedAt: '2026-04-04T01:05:00.000Z',
    })

    expect(shouldKeepLoopRunOpen(run)).toBe(false)
  })
})

