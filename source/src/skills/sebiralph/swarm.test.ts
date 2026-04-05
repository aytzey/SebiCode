import { describe, expect, test } from 'bun:test'
import type { RalphPlan } from './types.js'
import { buildWorkerPrompt } from './swarm.js'

const plan: RalphPlan = {
  title: 'Auth work',
  summary: 'Add auth guard',
  sharedContracts: {},
  tasks: [
    {
      id: 'task-contract',
      title: 'Define auth types',
      description: 'Add shared auth contract',
      role: 'worker',
      modelRef: { provider: 'openai', model: 'gpt-5.4' },
      ownedPaths: ['src/auth/types.ts'],
      dependsOn: [],
      inputs: [],
      outputs: ['src/auth/types.ts'],
      acceptanceChecks: ['Typecheck auth types'],
      wave: 0,
      status: 'approved',
    },
    {
      id: 'task-guard',
      title: 'Protect dashboard route',
      description: 'Gate dashboard access behind auth',
      role: 'worker',
      modelRef: { provider: 'openai', model: 'gpt-5.4' },
      ownedPaths: ['src/routes/dashboard.ts', 'src/routes/dashboard.test.ts'],
      dependsOn: ['task-contract'],
      inputs: ['src/routes/dashboard.ts'],
      outputs: ['src/routes/dashboard.ts', 'src/routes/dashboard.test.ts'],
      acceptanceChecks: ['Add regression test for unauthenticated access'],
      wave: 1,
      status: 'pending',
    },
  ],
  waves: [
    { wave: 0, type: 'contracts', taskIds: ['task-contract'] },
    { wave: 1, type: 'implementation', taskIds: ['task-guard'] },
  ],
}

describe('worker prompts', () => {
  test('worker prompt enforces bounded execution and anti-stall rules', () => {
    const task = plan.tasks[1]!
    const prompt = buildWorkerPrompt(task, plan, true)

    expect(prompt).toContain('ROLE:')
    expect(prompt).toContain('INSTRUCTIONS')
    expect(prompt).toContain('STEPS')
    expect(prompt).toContain('END GOAL')
    expect(prompt).toContain('NARROWING')
    expect(prompt).toContain('Do NOT stop after saying what you plan to do next; do the tool call in the same turn')
    expect(prompt).toContain('Do NOT claim completion without commit-ready verification evidence')
    expect(prompt).toContain('You are a dispatched execution subagent inside an already-approved SebiRalph harness run')
    expect(prompt).toContain('Helpful execution, framework, domain, and UI skills are allowed')
    expect(prompt).toContain('If a skill says it should be skipped for dispatched subagents or contains `<SUBAGENT-STOP>`, you MUST skip it')
    expect(prompt).toContain('TDD is ON.')
    expect(prompt).toContain('Implement, test, commit.')
  })

  test('worker prompt still requires verification when tdd is off', () => {
    const task = plan.tasks[1]!
    const prompt = buildWorkerPrompt(task, plan, false)

    expect(prompt).toContain('Verification is still required even though TDD is OFF')
    expect(prompt).not.toContain('Run that targeted test first and observe it fail')
  })
})
