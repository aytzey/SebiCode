import { describe, expect, test } from 'bun:test'
import { deriveRunHydrationFromTranscript } from './markers.js'

describe('deriveRunHydrationFromTranscript', () => {
  test('keeps run state scoped to the matching run_id', () => {
    const runA = 'run-a'
    const runB = 'run-b'

    const hydration = deriveRunHydrationFromTranscript({
      runId: runA,
      modifiedAt: '2026-04-04T01:00:00.000Z',
      messages: [
        {
          text: `<sebiralph-progress run_id="${runA}" phase="plan" status="entered" />`,
        },
        {
          text:
            `<sebiralph-progress run_id="${runB}" phase="completed" status="completed" />\n` +
            `<sebiralph-integration run_id="${runB}" branch="ralph/integration-b" />\n` +
            `<sebiralph-deploy run_id="${runB}" status="passed" target="staging" url="https://example.test" />\n` +
            'SebiRalph complete. Integration branch: `ralph/integration-b`. Deploy verification: PASS.',
        },
      ],
    })

    expect(hydration.phase).toBe('plan')
    expect(hydration.status).toBe('active')
    expect(hydration.integrationBranch).toBeUndefined()
    expect(hydration.deploy?.status).toBeUndefined()
  })

  test('treats non-final phase completion as an active run', () => {
    const hydration = deriveRunHydrationFromTranscript({
      runId: 'run-a',
      modifiedAt: '2026-04-04T01:02:00.000Z',
      messages: [
        {
          text: '<sebiralph-progress run_id="run-a" phase="plan" status="completed" />',
        },
      ],
    })

    expect(hydration.phase).toBe('plan')
    expect(hydration.status).toBe('active')
  })

  test('marks the run blocked when the latest assistant message is an API error', () => {
    const hydration = deriveRunHydrationFromTranscript({
      runId: 'run-a',
      modifiedAt: '2026-04-04T01:05:00.000Z',
      messages: [
        {
          text: '<sebiralph-progress run_id="run-a" phase="config_review" status="entered" />',
        },
        {
          text:
            "There's an issue with the selected model (gpt-5.4). It may not exist or you may not have access to it.",
          isApiError: true,
        },
      ],
    })

    expect(hydration.phase).toBe('blocked')
    expect(hydration.status).toBe('blocked')
    expect(hydration.lastError).toContain('selected model')
    expect(hydration.deploy?.status).toBe('blocked')
  })

  test('clears a stale API error after later scoped progress and deploy markers', () => {
    const hydration = deriveRunHydrationFromTranscript({
      runId: 'run-a',
      modifiedAt: '2026-04-04T01:10:00.000Z',
      messages: [
        {
          text: '<sebiralph-progress run_id="run-a" phase="plan" status="entered" />',
        },
        {
          text: 'temporary provider outage',
          isApiError: true,
        },
        {
          text:
            '<sebiralph-progress run_id="run-a" phase="deploy_verify" status="completed" />\n' +
            '<sebiralph-progress run_id="run-a" phase="completed" status="completed" />\n' +
            '<sebiralph-integration run_id="run-a" branch="ralph/integration-123" />\n' +
            '<sebiralph-deploy run_id="run-a" status="passed" target="preview" url="https://preview.test" />',
        },
      ],
    })

    expect(hydration.phase).toBe('completed')
    expect(hydration.status).toBe('completed')
    expect(hydration.integrationBranch).toBe('ralph/integration-123')
    expect(hydration.deploy?.status).toBe('passed')
    expect(hydration.lastError).toBeNull()
  })

  test('uses the legacy final report when only one run is present in the transcript', () => {
    const hydration = deriveRunHydrationFromTranscript({
      runId: 'run-a',
      modifiedAt: '2026-04-04T01:15:00.000Z',
      messages: [
        {
          text: '<sebiralph-progress run_id="run-a" phase="deploy_verify" status="completed" />',
        },
        {
          text:
            'SebiRalph complete. Integration branch: `ralph/integration-legacy`. Deploy verification: PASS.',
        },
      ],
    })

    expect(hydration.phase).toBe('completed')
    expect(hydration.status).toBe('completed')
    expect(hydration.integrationBranch).toBe('ralph/integration-legacy')
    expect(hydration.deploy?.status).toBe('passed')
  })

  test('tracks the latest quality loop verdict and iteration count', () => {
    const hydration = deriveRunHydrationFromTranscript({
      runId: 'run-a',
      modifiedAt: '2026-04-04T01:20:00.000Z',
      messages: [
        {
          text:
            '<sebiralph-loop run_id="run-a" iteration="1" verdict="refine" />\n' +
            '<sebiralph-deploy run_id="run-a" status="passed" target="preview" url="https://preview-1.test" />',
        },
        {
          text:
            '<sebiralph-loop run_id="run-a" iteration="2" verdict="ship_it" />\n' +
            '<sebiralph-progress run_id="run-a" phase="completed" status="completed" />',
        },
      ],
    })

    expect(hydration.qualityLoopsCompleted).toBe(2)
    expect(hydration.lastQualityVerdict).toBe('ship_it')
    expect(hydration.phase).toBe('completed')
    expect(hydration.status).toBe('completed')
  })
})
