import { describe, expect, test } from 'bun:test'
import {
  normalizeSebiRalphTaskText,
  selectReusableSebiRalphRun,
} from './selection.js'
import type { SebiRalphRunLookup } from './types.js'

function makeLookup(
  overrides: Partial<SebiRalphRunLookup['run']>,
): SebiRalphRunLookup {
  return {
    transcriptFound: true,
    run: {
      id: 'run-1',
      sessionId: 'session-1',
      projectPath: '/tmp/project',
      userTask: 'build feature',
      createdAt: '2026-04-04T00:00:00.000Z',
      updatedAt: '2026-04-04T00:00:00.000Z',
      launchMode: 'loop',
      config: {} as SebiRalphRunLookup['run']['config'],
      workflow: {
        tdd: true,
        deployVerification: true,
        loopMode: true,
        maxPlanIterations: 3,
        maxGateFixAttempts: 2,
        maxReviewFixCycles: 2,
        maxDeployFixCycles: 3,
        maxQualityLoops: 3,
      },
      executionPolicy: {
        fullAuto: true,
        tdd: true,
        deployVerification: true,
        loopMode: true,
        optionalRemotePush: true,
        maxPlanIterations: 3,
        maxGateFixAttempts: 2,
        maxReviewFixCycles: 2,
        maxDeployFixCycles: 3,
        maxQualityLoops: 3,
      },
      phase: 'plan',
      status: 'active',
      taskRecords: [],
      waveRecords: [],
      deploy: {
        status: 'unknown',
        fixCycles: 0,
      },
      ...overrides,
    },
  }
}

describe('selectReusableSebiRalphRun', () => {
  test('normalizes repeated whitespace in task text', () => {
    expect(normalizeSebiRalphTaskText('  ralph   loop   test  ')).toBe(
      'ralph loop test',
    )
  })

  test('reuses the matching active run for the same task and mode', () => {
    const lookups = [
      makeLookup({
        id: 'other-task',
        userTask: 'different task',
      }),
      makeLookup({
        id: 'target',
        userTask: 'mukemmel  olana   kadar geliştir',
        updatedAt: '2026-04-04T01:00:00.000Z',
      }),
    ]

    const selected = selectReusableSebiRalphRun(lookups, {
      userTask: 'mukemmel olana kadar geliştir',
      launchMode: 'loop',
      currentSessionId: 'session-1',
    })

    expect(selected?.run.id).toBe('target')
  })

  test('prefers the current-session run over older matches', () => {
    const lookups = [
      makeLookup({
        id: 'older-same-task',
        sessionId: 'other-session',
        updatedAt: '2026-04-04T01:10:00.000Z',
      }),
      makeLookup({
        id: 'current-session',
        sessionId: 'session-1',
        updatedAt: '2026-04-04T01:00:00.000Z',
      }),
    ]

    const selected = selectReusableSebiRalphRun(lookups, {
      userTask: 'build feature',
      launchMode: 'loop',
      currentSessionId: 'session-1',
    })

    expect(selected?.run.id).toBe('current-session')
  })

  test('does not reuse completed runs or runs from another mode', () => {
    const lookups = [
      makeLookup({
        id: 'completed',
        status: 'completed',
      }),
      makeLookup({
        id: 'standard-run',
        launchMode: 'standard',
      }),
    ]

    const selected = selectReusableSebiRalphRun(lookups, {
      userTask: 'build feature',
      launchMode: 'loop',
      currentSessionId: 'session-1',
    })

    expect(selected).toBeNull()
  })
})
