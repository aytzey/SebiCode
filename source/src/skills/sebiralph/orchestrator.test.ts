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
    expect(prompt).toContain('<sebiralph-loop run_id="run-loop" iteration="{quality_iteration}" verdict="{refine|ship_it|limit_reached}" />')
    expect(prompt).toContain('NO STATUS-ONLY STALLS')
    expect(prompt).toContain('TOOL-FIRST AUTONOMY')
    expect(prompt).toContain('SELF-CHECK BEFORE RETURNING')
    expect(prompt).toContain('Reject only for concrete, evidence-backed issues')
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
    expect(prompt).toContain('Do not end your turn after saying you will revise the plan.')
    expect(prompt).toContain('prefer a tool-only turn')
    expect(prompt).toContain('Do NOT claim completion without commit-ready verification evidence')
    expect(prompt).toContain('Do NOT reject for style preferences, optional polish, or speculative concerns')
    expect(prompt).toContain('at least one task must own the relevant test files and explicitly name that coverage in acceptanceChecks')
    expect(prompt).toContain('at least one test-owning task explicitly covers that behavior')
    expect(prompt).toContain('DEFAULT SMALL DECISIONS')
    expect(prompt).toContain('default to `low/medium/high` unless an external contract or repo convention says otherwise')
    expect(prompt).toContain('Do NOT stop to ask the user about local enum/value choices')
    expect(prompt).toContain('apply one final manual plan correction yourself in the same turn and continue')
    expect(prompt).toContain('The first character of your response must be { and the last character must be }')
    expect(prompt).toContain('If you emit backticks, markdown fences, or any text before/after the JSON object, the response is invalid')
    expect(prompt).toContain('any sentence before the opening { are invalid')
    expect(prompt).toContain('If you emit backticks, markdown fences, or any text before/after the JSON object, the revision is invalid')
    expect(prompt).toContain("The corrected plan is below")
    expect(prompt).toContain('These subagents are dispatched executors inside an already-approved harness run.')
    expect(prompt).toContain('Helpful execution, framework, domain, UI, and audit skills are allowed when they materially accelerate the assigned work.')
    expect(prompt).toContain("If a surfaced skill says it should be skipped for dispatched subagents or contains `<SUBAGENT-STOP>`, skip it and keep executing the assigned task.")
    expect(prompt).toContain('default to a project-local `.worktrees/` directory')
    expect(prompt).toContain('run the cheapest gates that still provide real confidence')
    expect(prompt).toContain('Approve unless there is a concrete blocker')
  })

  test('includes durable run metadata and marker protocol when runtime context exists', () => {
    const prompt = buildHarnessPrompt(
      'Ship a stateful harness run',
      DEFAULT_CONFIG,
      DEFAULT_WORKFLOW,
      {
        runId: 'run-123',
        sessionId: 'session-456',
      },
    )

    expect(prompt).toContain('## Run Metadata')
    expect(prompt).toContain('SebiRalph run id: run-123')
    expect(prompt).toContain('Session id: session-456')
    expect(prompt).toContain('## Progress Marker Protocol')
    expect(prompt).toContain(
      '<sebiralph-progress run_id="run-123" phase="{phase_id}" status="entered" />',
    )
  })
})
