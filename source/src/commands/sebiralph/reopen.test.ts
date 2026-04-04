import { describe, expect, test } from 'bun:test'
import {
  grantManualLoopExtension,
  shouldGrantManualLoopExtension,
  shouldKeepLoopRunOpen,
} from './reopen.js'
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
  test('grantManualLoopExtension reactivates a completed run and increments the extension budget', () => {
    const reopened = grantManualLoopExtension(
      makeRun(),
      '2026-04-04T01:05:00.000Z',
    )

    expect(reopened.phase).toBe('deploy_verify')
    expect(reopened.status).toBe('active')
    expect(reopened.qualityLoopExtensions).toBe(1)
    expect(reopened.reopenRequestedAt).toBe('2026-04-04T01:05:00.000Z')
    expect(reopened.completedAt).toBeUndefined()
  })

  test('grantManualLoopExtension reactivates a loop stopped by quality limit', () => {
    const reopened = grantManualLoopExtension(
      makeRun({
        phase: 'blocked',
        status: 'blocked',
        lastQualityVerdict: 'limit_reached',
        completedAt: undefined,
      }),
      '2026-04-04T01:05:00.000Z',
    )

    expect(reopened.phase).toBe('deploy_verify')
    expect(reopened.status).toBe('active')
    expect(reopened.qualityLoopExtensions).toBe(1)
    expect(reopened.lastQualityVerdict).toBeUndefined()
  })

  test('shouldGrantManualLoopExtension is true for completed or limit-reached loop runs', () => {
    expect(shouldGrantManualLoopExtension(makeRun())).toBe(true)
    expect(
      shouldGrantManualLoopExtension(
        makeRun({
          phase: 'blocked',
          status: 'blocked',
          lastQualityVerdict: 'limit_reached',
          completedAt: undefined,
        }),
      ),
    ).toBe(true)
  })

  test('shouldGrantManualLoopExtension is true when the effective quality budget is exhausted', () => {
    expect(
      shouldGrantManualLoopExtension(
        makeRun({
          phase: 'deploy_verify',
          status: 'active',
          lastQualityVerdict: 'refine',
          qualityLoopsCompleted: 3,
          completedAt: undefined,
        }),
      ),
    ).toBe(true)
  })

  test('shouldGrantManualLoopExtension does not re-grant on an already reactivated run with remaining budget', () => {
    expect(
      shouldGrantManualLoopExtension(
        makeRun({
          phase: 'deploy_verify',
          status: 'active',
          lastQualityVerdict: 'limit_reached',
          qualityLoopsCompleted: 3,
          qualityLoopExtensions: 1,
          completedAt: undefined,
        }),
      ),
    ).toBe(false)
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

  test('shouldKeepLoopRunOpen preserves a manually extended quality-limit block without external errors', () => {
    const run = makeRun({
      phase: 'blocked',
      status: 'blocked',
      lastQualityVerdict: 'limit_reached',
      completedAt: undefined,
      reopenRequestedAt: '2026-04-04T01:05:00.000Z',
    })

    expect(shouldKeepLoopRunOpen(run)).toBe(true)
  })
})
