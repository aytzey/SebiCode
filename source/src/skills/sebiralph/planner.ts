import type { RalphConfig } from './types.js'
import { PLAN_JSON_SCHEMA_PROMPT } from './prd.js'
import { formatConfigSummary } from './config.js'

export const HARD_GATES = [
  'Every task has ownedPaths and at least one concrete acceptance check',
  'Dependencies are explicit enough to execute and do not contain cycles',
  'Behavior-changing work has concrete verification coverage; when the task explicitly calls for targeted store/shared-contract/API tests, at least one task that owns test files names that coverage explicitly',
  'Shared contract changes that would block parallel work are isolated before dependent tasks',
  'A final deploy/runtime verification path is identified, or the plan explicitly says user input is needed for deployment',
  'Wave assignment respects dependency order',
]

function formatDeliveryContext(deliveryContext?: string): string {
  const trimmed = deliveryContext?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : 'Not provided'
}

export type PlannerRevisionInput = {
  iteration: number
  maxIterations: number
  previousPlan: string
  evaluatorFeedback: string
}

export function buildPlannerPrompt(
  userTask: string,
  config: RalphConfig,
  codebaseContext: string,
  deliveryContext?: string,
  revision?: PlannerRevisionInput,
): string {
  // Cache-first ordering: every byte before the REVISION block is identical
  // for both the initial call and every revision call. The Anthropic prompt
  // cache hashes from the start of the message, so keeping codebase context,
  // delivery context, role assignments, instructions and self-checks in a
  // stable prefix means revisions reuse the cached prefix and only the trailing
  // REVISION block (a few hundred bytes) is uncached.
  return `ROLE:
You are the Planner for SebiRalph. Create a detailed implementation plan that is execution-ready, validator-safe, and evaluator-safe.

CONTEXT:
Task
${userTask}

Codebase Context
${codebaseContext}

Delivery Context
${formatDeliveryContext(deliveryContext)}

Role Assignments
${formatConfigSummary(config)}

ASK:
Produce a complete Ralph plan JSON for this task.

INSTRUCTIONS:
Follow the SebiRalph workflow exactly. Optimize for parallel execution, ownership clarity, low-friction execution, and concrete verification.

STEPS:
1. Break the work into discrete tasks with clear boundaries
2. Assign role: "worker" (backend/infra) or "frontend" (UI)
3. Identify shared contracts (types, API schema, DB) — these go in wave 0
4. Assign waves respecting dependencies
5. TDD is ON by default unless the user explicitly disables it. Prefer red-green-refactor for behavior changes, but keep the plan pragmatic
6. For each task define: ownedPaths (disjoint within wave), dependsOn, inputs, outputs, acceptanceChecks
7. Every task must include at least one concrete acceptance check. Use targeted test/regression/smoke coverage when it materially de-risks behavior changes
8. If the task changes shared store, contract, or API behavior and the user asked for targeted tests, at least one task must own the relevant test files and explicitly name that coverage in acceptanceChecks. Source-file acceptance alone is not enough
9. Include final deploy/runtime verification expectations in the acceptance checks of the last-wave tasks when the repo exposes a deployable surface
10. Prefer reasonable repo-consistent defaults over user clarification for bounded local decisions. If a new priority field has no existing enum or documented vocabulary, default to low/medium/high unless an external contract or repo convention says otherwise

END GOAL:
- Output a valid Ralph plan JSON object that can pass parsing, plan validation, and evaluator hard gates without manual cleanup
- Make the plan executable by downstream workers with no missing ownership or dependency information
- Minimize avoidable assumptions instead of over-planning

NARROWING:
- Do NOT emit prose, markdown fences, comments, headings, or explanations outside the JSON object
- The first character of your response must be { and the last character must be }
- If you emit backticks, markdown fences, or any text before/after the JSON object, the response is invalid
- Preparatory notes like "Here is the JSON", "Now I have everything I need", or any sentence before the opening { are invalid
- Do NOT leave ownedPaths, acceptanceChecks, inputs, or outputs empty when the task materially changes behavior
- Do NOT invent deploy commands or runtime surfaces that are not present in the delivery context
- Do NOT create overlapping same-wave ownership; split the work or move it to a later wave instead
- Do NOT produce placeholder values like "TBD", "etc", "same as above", or "..."; be explicit
- Do NOT stop to ask the user about local enum/value choices when a reasonable repo-consistent default exists

SELF-CHECK BEFORE RETURNING:
- JSON parses cleanly
- ownedPaths are present on every task
- dependsOn is acyclic
- wave ordering matches dependencies
- if the task changes shared store/contract/API behavior, at least one test-owning task explicitly covers that behavior
- final-wave acceptance checks mention deploy/runtime verification when a deployable surface exists

OUTPUT FORMAT
${PLAN_JSON_SCHEMA_PROMPT}
${revision ? `
REVISION:
You are revising a rejected plan (iteration ${revision.iteration}/${revision.maxIterations}).
Reuse every byte of the prefix above as the cached context for this revision; do not re-derive it.

PREVIOUS PLAN
${revision.previousPlan}

EVALUATOR FEEDBACK
${revision.evaluatorFeedback}

REFINEMENT RULES:
- Address every failed gate and every fix request
- Preserve valid structure and valid task details instead of rewriting everything blindly
- Remove contradictions, overlaps, and missing ownership explicitly
- If feedback says verification is missing, add or update a task that owns the relevant test files and names that coverage explicitly; do not rely on source-file acceptance alone
- If task A depends on task B, task A cannot remain in the same wave as task B
- Do NOT introduce new unsupported assumptions or placeholder fields
- Return the final revised JSON only, with no commentary or fences
- The first character of your response must be { and the last character must be }
` : ''}
Output ONLY the JSON object.`
}

export function buildEvaluatorPrompt(
  planJson: string,
  userTask: string,
  deliveryContext?: string,
): string {
  return `ROLE:
You are the Evaluator. Review this plan against hard gates and reject only for concrete, actionable failures.

CONTEXT:
Original Task
${userTask}

Delivery Context
${formatDeliveryContext(deliveryContext)}

Plan
${planJson}

ASK:
Decide whether the plan is ready for execution.

RULES:
- Evaluate every hard gate exactly once
- Approve unless there is a concrete blocker that is likely to break execution, ownership, dependency flow, or deploy verification
- Mark FAIL only when the plan text actually lacks required evidence or violates a rule
- Do NOT reject for style preferences, optional polish, or speculative concerns
- Treat minor omissions, naming tweaks, or optimizable sequencing as PASS when execution can still proceed safely
- Distinguish explicit evidence from inference; when you infer, say so briefly
- Every fix must map to a failed gate and be minimally scoped

HARD GATES — ALL must pass
${HARD_GATES.map((g, i) => `${i + 1}. ${g}`).join('\n')}

OUTPUT FORMAT:
VERDICT: APPROVED or VERDICT: REJECTED
GATE RESULTS:
1. PASS | <gate> | <reason>
2. FAIL | <gate> | <reason>
...
FIXES NEEDED:
- [fix per failed gate]

If ALL pass: VERDICT: APPROVED
If ANY fail: VERDICT: REJECTED
FIXES NEEDED:
- [fix per failed gate]`
}

export function parseEvaluatorVerdict(response: string): { approved: boolean; fixes: string[]; rawResponse: string } {
  const approved = /VERDICT:\s*APPROVED/i.test(response)
  const fixes: string[] = []
  if (!approved) {
    const fixSection = response.split('FIXES NEEDED:')[1]
    if (fixSection) fixes.push(...fixSection.split('\n').filter(l => l.trim().startsWith('-')).map(l => l.trim().replace(/^-\s*/, '')))
  }
  return { approved, fixes, rawResponse: response }
}

/**
 * Build a planner revision prompt.
 *
 * Important: revisions reuse the EXACT same prefix bytes as the original
 * planner call (codebase context, delivery context, role assignments,
 * instructions, self-checks). Only the trailing REVISION block differs,
 * which lets the Anthropic prompt cache reuse the cached prefix and skip
 * re-uploading the codebase context every iteration.
 *
 * Callers MUST pass the SAME `userTask`, `config`, and `codebaseContext`
 * they passed to `buildPlannerPrompt` for the initial attempt — otherwise
 * the cache prefix changes and the revision pays full token cost again.
 */
export function buildRevisionPrompt(
  userTask: string,
  config: RalphConfig,
  codebaseContext: string,
  originalPlan: string,
  evaluatorFeedback: string,
  iteration: number,
  deliveryContext?: string,
  maxIterations = 3,
): string {
  return buildPlannerPrompt(userTask, config, codebaseContext, deliveryContext, {
    iteration,
    maxIterations,
    previousPlan: originalPlan,
    evaluatorFeedback,
  })
}
