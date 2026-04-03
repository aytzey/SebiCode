import type { RalphConfig } from './types.js'
import { PLAN_JSON_SCHEMA_PROMPT } from './prd.js'
import { formatConfigSummary } from './config.js'

export const HARD_GATES = [
  'Every task has ownedPaths (no unowned files)',
  'Dependencies are explicit and acyclic',
  'Acceptance criteria are testable (build/test/lint can verify)',
  'Shared contract changes have a dedicated task in wave 0',
  'No more than 2 unresolved assumptions',
  'Wave assignment respects dependency order',
]

export function buildPlannerPrompt(userTask: string, config: RalphConfig, codebaseContext: string): string {
  return `You are the Planner. Create a detailed implementation plan.

## Task
${userTask}

## Codebase Context
${codebaseContext}

## Role Assignments
${formatConfigSummary(config)}

## Instructions
1. Break the work into discrete tasks with clear boundaries
2. Assign role: "worker" (backend/infra) or "frontend" (UI)
3. Identify shared contracts (types, API schema, DB) — these go in wave 0
4. Assign waves respecting dependencies
5. For each task define: ownedPaths (disjoint within wave), dependsOn, inputs, outputs, acceptanceChecks

## Output Format
${PLAN_JSON_SCHEMA_PROMPT}

Output ONLY the JSON object.`
}

export function buildEvaluatorPrompt(planJson: string, userTask: string): string {
  return `You are the Evaluator. Review this plan against hard gates.

## Original Task
${userTask}

## Plan
${planJson}

## Hard Gates — ALL must pass
${HARD_GATES.map((g, i) => `${i + 1}. ${g}`).join('\n')}

Check each gate: PASS or FAIL with reason.

If ALL pass: VERDICT: APPROVED
If ANY fail: VERDICT: REJECTED
FIXES NEEDED:
- [fix per failed gate]`
}

export function parseEvaluatorVerdict(response: string): { approved: boolean; fixes: string[]; rawResponse: string } {
  const approved = response.includes('VERDICT: APPROVED')
  const fixes: string[] = []
  if (!approved) {
    const fixSection = response.split('FIXES NEEDED:')[1]
    if (fixSection) fixes.push(...fixSection.split('\n').filter(l => l.trim().startsWith('-')).map(l => l.trim().replace(/^-\s*/, '')))
  }
  return { approved, fixes, rawResponse: response }
}

export function buildRevisionPrompt(originalPlan: string, evaluatorFeedback: string, iteration: number): string {
  return `You are the Planner. Evaluator rejected your plan (iteration ${iteration}/3).

## Previous Plan
${originalPlan}

## Feedback
${evaluatorFeedback}

Revise to address ALL feedback. Output ONLY the revised JSON plan.`
}
