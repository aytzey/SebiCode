import { describe, expect, test } from 'bun:test'
import { buildHarnessPrompt } from './orchestrator.js'
import { DEFAULT_CONFIG, DEFAULT_WORKFLOW, LOOP_WORKFLOW } from './types.js'

describe('buildHarnessPrompt', () => {
  test('enables explicit refinement loop instructions in loop mode', () => {
    const prompt = buildHarnessPrompt(
      'Ship a stronger implementation',
      DEFAULT_CONFIG,
      LOOP_WORKFLOW,
      { runId: 'run-loop' },
    )

    expect(prompt).toContain('Loop mode: ON')
    expect(prompt).toContain('QUALITY_VERDICT: SHIP_IT')
    expect(prompt).toContain('return to Phase 5 → 6 → 7 → 8')
    expect(prompt).toContain(`${LOOP_WORKFLOW.maxQualityLoops} refinement loops`)
    expect(prompt).toContain('PRE-APPROVED')
    expect(prompt).toContain('Treat \'good enough\' as a REFINE verdict.')
  })

  test('keeps loop mode disabled in the standard workflow', () => {
    const prompt = buildHarnessPrompt(
      'Ship a solid implementation',
      DEFAULT_CONFIG,
      DEFAULT_WORKFLOW,
      { runId: 'run-standard' },
    )

    expect(prompt).toContain('Loop mode: OFF')
    expect(prompt).toContain('Disabled unless the user explicitly asks for another refinement round.')
    expect(prompt).not.toContain('QUALITY_VERDICT: SHIP_IT')
    expect(prompt).toContain('Phases 0 and 4 are HARD STOPS')
  })
})
