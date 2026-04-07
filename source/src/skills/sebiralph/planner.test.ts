import { describe, expect, test } from 'bun:test'
import { DEFAULT_CONFIG } from './types.js'
import {
  buildEvaluatorPrompt,
  buildPlannerPrompt,
  buildRevisionPrompt,
} from './planner.js'

describe('planner prompts', () => {
  test('planner prompt uses explicit structured sections and narrowing rules', () => {
    const prompt = buildPlannerPrompt(
      'Add session-based auth',
      DEFAULT_CONFIG,
      'Next.js app with Vitest',
      'Deploy via `npm run deploy`, verify via `npm run smoke`',
    )

    expect(prompt).toContain('ROLE:')
    expect(prompt).toContain('CONTEXT:')
    expect(prompt).toContain('ASK:')
    expect(prompt).toContain('STEPS:')
    expect(prompt).toContain('END GOAL:')
    expect(prompt).toContain('NARROWING:')
    expect(prompt).toContain('SELF-CHECK BEFORE RETURNING:')
    expect(prompt).toContain('Do NOT invent deploy commands')
    expect(prompt).toContain('The first character of your response must be { and the last character must be }')
    expect(prompt).toContain('If you emit backticks, markdown fences, or any text before/after the JSON object, the response is invalid')
    expect(prompt).toContain('any sentence before the opening { are invalid')
    expect(prompt).toContain('at least one task must own the relevant test files and explicitly name that coverage in acceptanceChecks')
    expect(prompt).toContain('at least one test-owning task explicitly covers that behavior')
    expect(prompt).toContain('default to low/medium/high unless an external contract or repo convention says otherwise')
    expect(prompt).toContain('Do NOT stop to ask the user about local enum/value choices')
    expect(prompt).toContain('Output ONLY the JSON object.')
  })

  test('evaluator prompt rejects only for concrete failures and requires gate results', () => {
    const prompt = buildEvaluatorPrompt(
      '{"title":"Auth"}',
      'Add session-based auth',
      'Deploy via `npm run deploy`',
    )

    expect(prompt).toContain('RULES:')
    expect(prompt).toContain('Approve unless there is a concrete blocker')
    expect(prompt).toContain('Do NOT reject for style preferences, optional polish, or speculative concerns')
    expect(prompt).toContain('Treat minor omissions, naming tweaks, or optimizable sequencing as PASS')
    expect(prompt).toContain('at least one task that owns test files names that coverage explicitly')
    expect(prompt).toContain('GATE RESULTS:')
    expect(prompt).toContain('VERDICT: APPROVED')
    expect(prompt).toContain('VERDICT: REJECTED')
  })

  test('revision prompt follows feedback-driven refinement contract', () => {
    const prompt = buildRevisionPrompt(
      'Add session-based auth',
      DEFAULT_CONFIG,
      'Next.js app with Vitest',
      '{"title":"Auth"}',
      'VERDICT: REJECTED\nFIXES NEEDED:\n- add wave 0 contract task',
      2,
      'Verify via `npm run smoke`',
    )

    expect(prompt).toContain('REVISION:')
    expect(prompt).toContain('iteration 2/3')
    expect(prompt).toContain('PREVIOUS PLAN')
    expect(prompt).toContain('{"title":"Auth"}')
    expect(prompt).toContain('EVALUATOR FEEDBACK')
    expect(prompt).toContain('add wave 0 contract task')
    expect(prompt).toContain('Preserve valid structure and valid task details instead of rewriting everything blindly')
    expect(prompt).toContain('add or update a task that owns the relevant test files and names that coverage explicitly')
    expect(prompt).toContain('task A depends on task B')
    expect(prompt).toContain('Return the final revised JSON only, with no commentary or fences')
    expect(prompt).toContain('The first character of your response must be { and the last character must be }')
    expect(prompt).toContain('Output ONLY the JSON object.')
  })

  test('revision prompt shares the same cacheable prefix as the initial planner prompt', () => {
    const userTask = 'Add session-based auth'
    const codebaseContext = 'Next.js app with Vitest, lots of context here that should be cached across plan iterations.'
    const deliveryContext = 'Verify via `npm run smoke`'
    const initial = buildPlannerPrompt(
      userTask,
      DEFAULT_CONFIG,
      codebaseContext,
      deliveryContext,
    )
    const revision = buildRevisionPrompt(
      userTask,
      DEFAULT_CONFIG,
      codebaseContext,
      '{"title":"Auth"}',
      'FIXES NEEDED:\n- add wave 0 contract task',
      2,
      deliveryContext,
    )

    // The initial prompt ends with the JSON-only directive. The revision must
    // start with the SAME prefix (codebase context + delivery context + role
    // assignments + instructions + self-checks) so the Anthropic prompt cache
    // hashes the cached prefix and only the trailing REVISION block is fresh.
    const sharedPrefixIndex = revision.indexOf('REVISION:')
    expect(sharedPrefixIndex).toBeGreaterThan(0)
    const sharedPrefix = revision.slice(0, sharedPrefixIndex)
    expect(initial.startsWith(sharedPrefix)).toBe(true)
    // The shared prefix must include the codebase context payload — that is
    // the entire point of the cache reuse.
    expect(sharedPrefix).toContain(codebaseContext)
  })
})
