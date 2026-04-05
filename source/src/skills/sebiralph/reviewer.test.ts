import { describe, expect, test } from 'bun:test'
import type { PRDTask } from './types.js'
import { buildFixPrompt, buildReviewPrompt } from './reviewer.js'

const task: PRDTask = {
  id: 'task-auth',
  title: 'Add auth guard',
  description: 'Protect dashboard route',
  role: 'worker',
  modelRef: { provider: 'openai', model: 'gpt-5.4' },
  ownedPaths: ['src/routes/dashboard.ts', 'src/routes/dashboard.test.ts'],
  dependsOn: [],
  inputs: ['src/routes/dashboard.ts'],
  outputs: ['src/routes/dashboard.ts', 'src/routes/dashboard.test.ts'],
  acceptanceChecks: ['Add a regression test for unauthenticated access'],
  wave: 1,
  status: 'pending',
}

describe('reviewer prompts', () => {
  test('review prompt blocks only on evidence-backed issues', () => {
    const prompt = buildReviewPrompt(task, 'diff --git a/src/routes/dashboard.ts', true)

    expect(prompt).toContain('REVIEW PRINCIPLES')
    expect(prompt).toContain('You are a dispatched review subagent inside an already-approved SebiRalph harness run')
    expect(prompt).toContain('Helpful execution, framework, domain, or audit skills are allowed')
    expect(prompt).toContain('Approve by default')
    expect(prompt).toContain('Reject only for concrete, evidence-backed issues')
    expect(prompt).toContain('Do NOT block on style-only nits, optional refactors, or vague maintainability concerns without a concrete failure mode')
    expect(prompt).toContain('TDD is ON.')
    expect(prompt).toContain('VERDICT: APPROVED')
    expect(prompt).toContain('VERDICT: NEEDS_FIX')
  })

  test('fix prompt keeps the repair scoped and non-stalling', () => {
    const prompt = buildFixPrompt(
      task,
      'ISSUES:\n- [severity: high] missing regression\nFIX_INSTRUCTIONS:\n- add regression',
    )

    expect(prompt).toContain('RULES')
    expect(prompt).toContain('You are a dispatched fix subagent inside an already-approved SebiRalph harness run')
    expect(prompt).toContain('Helpful execution, framework, domain, or audit skills are allowed')
    expect(prompt).toContain('Fix ONLY the identified issues')
    expect(prompt).toContain('Do not stop after a status update; either change code, run verification, commit, or report a real blocker')
    expect(prompt).toContain('Commit the fix.')
  })
})
