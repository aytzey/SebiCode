/**
 * SebiRalph Harness Orchestrator
 *
 * Builds a structured 8-phase harness prompt that inlines content from all
 * sebiralph modules. The AI follows this prompt deterministically, making
 * tool calls at each phase with exact templates provided.
 *
 * Modules used:
 *  - config.ts   → role-model display
 *  - planner.ts  → planner/evaluator prompt templates, hard gates
 *  - prd.ts      → JSON schema, plan validation criteria, markdown render
 *  - swarm.ts    → worker prompt template
 *  - reviewer.ts → review prompt template, fix prompt template
 *  - gates.ts    → deterministic gate commands
 *  - integration.ts → git worktree/branch commands
 */

import type { RalphConfig, RalphRole } from './types.js'
import { formatConfigSummary } from './config.js'
import { PLAN_JSON_SCHEMA_PROMPT } from './prd.js'
import { HARD_GATES } from './planner.js'

// ---------------------------------------------------------------------------
// Phase builders — each returns a section of the harness prompt
// ---------------------------------------------------------------------------

function phaseConfig(config: RalphConfig): string {
  return `
## PHASE 0 — Config Review  ✦ HARD STOP

Current role assignments:
${formatConfigSummary(config)}

Display this table to the user and ask:
> "SebiRalph config above. Approve? Reply **yes** to proceed, or **role=N** to change (e.g. worker=4 frontend=2)."

**DO NOT proceed to Phase 1 until the user explicitly approves.**
If the user changes roles, display the updated table and ask again.
`
}

function phaseExplore(): string {
  return `
## PHASE 1 — Codebase Exploration

**Entry:** Config approved.
**Goal:** Build a concise codebase context string for the Planner.

Use these tools:
1. \`Glob("**/*.{ts,tsx,js,jsx,py,go,rs,java}")\` — file tree
2. \`Read(package.json)\` or equivalent manifest — dependencies, scripts
3. \`Read(tsconfig.json)\` / \`Read(pyproject.toml)\` — build config
4. \`Read(CLAUDE.md)\` or \`Read(README.md)\` — project docs
5. \`Grep("import|from|require")\` on 2-3 key files — dependency graph

Produce a summary (assign to variable \`codebaseContext\`):
- Language & framework
- Directory structure (key dirs only)
- Test setup (runner, config file, test dir)
- Build system (bundler, compiler)
- Entry points

**Exit:** You have a clear codebase summary. Move to Phase 2.
`
}

function phasePlan(config: RalphConfig): string {
  const ref = (role: RalphRole) => `${config[role].provider}/${config[role].model}`

  return `
## PHASE 2 — Planning (Planner Subagent)

**Entry:** codebaseContext ready from Phase 1.

Spawn the Planner agent:

\`\`\`
Agent({
  description: "ralph-planner: create implementation plan",
  prompt: <see template below>,
  provider: "${config.planner.provider}",
  model: "opus"
})
\`\`\`

### Planner Prompt Template

Build the prompt by filling in {TASK}, {CODEBASE_CONTEXT}, and {CONFIG}:

\`\`\`
You are the Planner. Create a detailed implementation plan.

## Task
{TASK}

## Codebase Context
{CODEBASE_CONTEXT}

## Role Assignments
${formatConfigSummary(config)}

## Instructions
1. Break the work into discrete tasks with clear boundaries
2. Assign role: "worker" (backend/infra) or "frontend" (UI)
3. Identify shared contracts (types, API schema, DB) — these go in wave 0
4. Assign waves respecting dependencies
5. For each task define: ownedPaths (disjoint within wave), dependsOn, inputs, outputs, acceptanceChecks
6. Set modelRef for each task: worker tasks → { provider: "${config.worker.provider}", model: "${config.worker.model}" }, frontend tasks → { provider: "${config.frontend.provider}", model: "${config.frontend.model}" }

## Output Format
${PLAN_JSON_SCHEMA_PROMPT}

Output ONLY the JSON object.
\`\`\`

### Validation

After receiving the Planner's response, validate the JSON:
1. Parse as JSON — if parse fails, ask Planner to fix (max 2 attempts)
2. Check: every task has non-empty \`ownedPaths\`
3. Check: no circular dependencies (follow dependsOn chains)
4. Check: acceptance criteria are non-empty for every task
5. Check: shared contract tasks are in wave 0
6. Check: within each wave, no two tasks share overlapping owned paths

If validation fails, show errors and ask Planner to revise. Max 2 fix attempts.

**Exit:** Valid plan JSON. Move to Phase 3.
`
}

function phaseEvaluate(config: RalphConfig): string {
  return `
## PHASE 3 — Evaluation (Evaluator Subagent)

**Entry:** Valid plan JSON from Phase 2.

Spawn the Evaluator agent:

\`\`\`
Agent({
  description: "ralph-evaluator: review plan against hard gates",
  prompt: <see template below>,
  provider: "${config.evaluator.provider}"
})
\`\`\`

### Evaluator Prompt Template

\`\`\`
You are the Evaluator. Review this plan against hard gates.

## Original Task
{TASK}

## Plan
{PLAN_JSON}

## Hard Gates — ALL must pass
${HARD_GATES.map((g, i) => `${i + 1}. ${g}`).join('\n')}

Check each gate: PASS or FAIL with reason.

If ALL pass: VERDICT: APPROVED
If ANY fail: VERDICT: REJECTED
FIXES NEEDED:
- [fix per failed gate]
\`\`\`

### Verdict Handling

Parse the response:
- If contains \`VERDICT: APPROVED\` (case-insensitive) → proceed to Phase 4
- If contains \`VERDICT: REJECTED\` → extract fixes after "FIXES NEEDED:", then spawn revision:

\`\`\`
Agent({
  description: "ralph-planner: revise plan (iteration N/3)",
  prompt: "You are the Planner. Evaluator rejected your plan (iteration N/3).\\n\\n## Previous Plan\\n{PLAN_JSON}\\n\\n## Feedback\\n{EVALUATOR_RESPONSE}\\n\\nRevise to address ALL feedback. Output ONLY the revised JSON plan.",
  provider: "${config.planner.provider}",
  model: "opus"
})
\`\`\`

Re-evaluate with the revised plan. **Max 3 iterations.**
If still rejected after 3 iterations → show the evaluator's feedback to the user and ask for guidance.

**Exit:** Plan approved by evaluator. Move to Phase 4.
`
}

function phaseApprove(): string {
  return `
## PHASE 4 — PRD Approval  ✦ HARD STOP

**Entry:** Plan approved by evaluator.

Render the plan as a markdown table. For each wave, show:

| ID | Title | Role | Provider/Model | Owned Paths | Depends On | Acceptance Criteria |

Then ask the user:
> "Implementation plan above. Approve? Reply **Y** to start implementation, **n** to reject, or **edit** with changes."

**DO NOT proceed to Phase 5 until the user explicitly approves.**
If user requests edits, modify the plan and re-display.

**Exit:** User approves. Move to Phase 5.
`
}

function phaseImplement(config: RalphConfig): string {
  return `
## PHASE 5 — Swarm Implementation (Multi-Provider Parallel)

**Entry:** User approved plan.

Execute waves **sequentially**. Within each wave, spawn workers **in parallel**.

### Wave 0 (contracts/shared — SEQUENTIAL)

For each task in wave 0, spawn ONE AT A TIME (must complete before next):

\`\`\`
Agent({
  description: "ralph-worker: {task.title}",
  prompt: <worker prompt — see template below>,
  provider: "${config.worker.provider}",
  isolation: "worktree"
})
\`\`\`

Wait for completion before spawning the next wave-0 task.

### Wave 1+ (implementation — PARALLEL)

For each task in the wave, spawn ALL AT ONCE in a single message:

\`\`\`
Agent({
  description: "ralph-{task.role}: {task.title}",
  prompt: <worker prompt>,
  provider: "{frontend tasks → ${config.frontend.provider}, worker tasks → ${config.worker.provider}}",
  isolation: "worktree",
  run_in_background: true
})
\`\`\`

**CRITICAL**: All Agent calls for a wave MUST be in a SINGLE message to run in parallel.

### Waiting for Background Agents — KEEP-ALIVE RULE

**PROBLEM**: When background agents complete, notifications arrive as messages. If you respond with
just text ("Waiting for tX...") and no tool call, the turn ends and queued notifications cannot be
delivered. The user would have to type "continue" to unstick you.

**RULE**: After receiving a background agent notification, ALWAYS make a tool call — never respond
with text-only. This keeps the conversation flowing and allows queued notifications to be delivered.

Pattern to follow:
1. Receive task-notification → update your status tracking
2. Check: are ALL agents in this wave done?
   - **YES** → immediately proceed to Phase 6 (run gate commands)
   - **NO** → run \`Bash("echo 'Waiting for N remaining agents...'")\` to keep the turn alive
3. After the Bash result, check if more notifications arrived. Repeat until all done.

**NEVER** output "Waiting for X..." as your final response without a tool call.

### Provider Fallback

If an Agent call with \`provider: "openai"\` fails (model not found, auth error), immediately
retry with \`provider: "anthropic", model: "sonnet"\`. If the FIRST worker in a wave fails on openai,
switch ALL remaining workers in that wave to anthropic — don't fail one-by-one.
Same applies in reverse: if anthropic fails, fall back to openai.

### Worker Prompt Template

For each task, build the prompt:

\`\`\`
You are a worker agent implementing a specific task.

## Task: {task.title} ({task.id})
{task.description}

## Constraints
- ONLY modify: {task.ownedPaths as comma-separated backtick paths}
- Do NOT modify files outside owned paths

## Inputs: {task.inputs}
## Expected Outputs: {task.outputs}
## Dependencies: {list completed dependency tasks with their outputs}
## Acceptance Criteria
{task.acceptanceChecks as numbered list}

Implement, test, commit.
\`\`\`

### State Tracking

Maintain a status table as you go:

| Task | Wave | Role | Provider | Status |
|------|------|------|----------|--------|

Update after each agent completes. If an agent fails/crashes, mark as FAILED and continue.

**Exit:** All agents in wave completed. Move to Phase 6 for this wave.
`
}

function phaseGate(): string {
  return `
## PHASE 6 — Gate Validation (Per Worker)

**Entry:** Worker agent completed for a task.

For each completed worker, run these 4 gates via Bash in the worker's worktree directory.
The worktree path is returned by the Agent tool when \`isolation: "worktree"\` is used.

### Gate 1: Path Ownership
\`\`\`bash
cd {worktree_path} && git diff --name-only HEAD
\`\`\`
Check that ALL changed files are within the task's \`ownedPaths\`.
A file \`src/api/routes.ts\` is within owned path \`src/api/\` (prefix match with trailing /).

### Gate 2: Build
\`\`\`bash
cd {worktree_path} && test -f package.json && npm run build --if-present || test -f tsconfig.json && npx tsc --noEmit || echo "no build system"
\`\`\`

### Gate 3: Lint
\`\`\`bash
cd {worktree_path} && test -f package.json && npm run lint --if-present || test -f pyproject.toml && ruff check . || echo "no linter"
\`\`\`

### Gate 4: Test
\`\`\`bash
cd {worktree_path} && test -f package.json && npm test --if-present || test -f pytest.ini && pytest || echo "no test runner"
\`\`\`

### Gate Failure Handling

If ANY gate fails:
1. Spawn a fix agent in the SAME worktree:
\`\`\`
Agent({
  description: "ralph-fix: {task.title} gate failure",
  prompt: "Gate '{gate_name}' failed for task '{task.title}'.\\n\\nError output:\\n{gate_output}\\n\\nOwned paths: {ownedPaths}\\n\\nFix the issue. Stay within owned paths. Commit the fix.",
  provider: "{same provider as original worker}",
  cwd: "{worktree_path}"
})
\`\`\`
2. Re-run all 4 gates
3. **Max 2 fix attempts.** After that, mark task as GATE_FAILED and report to user.

**Exit:** All gates pass for all tasks in this wave. Move to Phase 7.
`
}

function phaseReview(config: RalphConfig): string {
  return `
## PHASE 7 — Review & Fix (Reviewer Subagent)

**Entry:** All gates passed for a task.

For each task that passed gates:

### Step 1: Get the diff
\`\`\`bash
cd {worktree_path} && git log --oneline main..HEAD && git diff main...HEAD
\`\`\`

### Step 2: Spawn Reviewer
\`\`\`
Agent({
  description: "ralph-reviewer: review {task.title}",
  prompt: <review prompt — see template below>,
  provider: "${config.reviewer.provider}",
  model: "opus"
})
\`\`\`

### Review Prompt Template

\`\`\`
Review this diff for task "{task.title}" ({task.id}).

## Acceptance Criteria
{task.acceptanceChecks as numbered list}

## Owned Paths: {task.ownedPaths}

## Diff
\\\`\\\`\\\`diff
{diff output}
\\\`\\\`\\\`

Focus on: logic, security, acceptance criteria.
Do NOT flag: style, build errors, missing tests (unless in criteria).

If good: VERDICT: APPROVED
If issues:
VERDICT: NEEDS_FIX
ISSUES:
- [issue]
FIX_INSTRUCTIONS:
- [fix]
\`\`\`

### Verdict Handling

- \`VERDICT: APPROVED\` → task ready for merge
- \`VERDICT: NEEDS_FIX\` → spawn fix agent:

\`\`\`
Agent({
  description: "ralph-fix: {task.title} review issues",
  prompt: "Reviewer found issues with '{task.title}'.\\n\\n## Feedback\\n{reviewer_response}\\n\\n## Owned Paths: {ownedPaths}\\n\\nFix ONLY the identified issues. Stay within owned paths. Commit the fix.",
  provider: "{same provider as original worker}",
  cwd: "{worktree_path}"
})
\`\`\`

Then re-run gates (Phase 6) and re-review. **Max 2 fix cycles.**
After that, mark as NEEDS_MANUAL_REVIEW and continue.

**Exit:** All tasks reviewed. Move to Phase 8.
`
}

function phaseMerge(): string {
  return `
## PHASE 8 — Merge & Summary

**Entry:** All tasks reviewed and approved (or marked for manual review).

### Step 1: Create integration branch
\`\`\`bash
git branch ralph/integration-$(date +%s | cut -c1-8)
\`\`\`

### Step 2: Merge each approved task
For each APPROVED task (skip GATE_FAILED and NEEDS_MANUAL_REVIEW):
\`\`\`bash
git checkout ralph/integration-{id}
git merge --no-ff -m "ralph: merge task {task.id} — {task.title}" {task_branch}
git checkout {original_branch}
\`\`\`

The task branch name is available from the Agent tool's worktree result.

### Step 3: Cleanup
For each worktree:
\`\`\`bash
git worktree remove {worktree_path} --force
git branch -D ralph/task-{task.id}
\`\`\`

### Step 4: Final Report

Output a summary table:

| Task | Status | Files Changed | Branch |
|------|--------|---------------|--------|

And the final message:
> "SebiRalph complete. Integration branch: \`ralph/integration-{id}\`. {N} tasks merged, {M} failed/manual."

If any tasks were GATE_FAILED or NEEDS_MANUAL_REVIEW, list them with details.
`
}

// ---------------------------------------------------------------------------
// Main export — assembles all phases into the harness prompt
// ---------------------------------------------------------------------------

export function buildHarnessPrompt(userTask: string, config: RalphConfig): string {
  return `# /sebiralph — Multi-Provider Swarm Harness

You are the SebiRalph orchestrator. Execute this task using a structured 8-phase workflow with multi-provider AI agents.

## Task
${userTask}

## Workflow Rules
- Execute phases IN ORDER (0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8)
- Phases 0 and 4 are HARD STOPS — wait for user approval
- Always set the \`provider\` field on Agent calls — it routes to the correct AI model
- Workers MUST use \`isolation: "worktree"\` for code isolation
- Wave 1+ workers MUST use \`run_in_background: true\` for parallel execution
- **KEEP-ALIVE**: When waiting for background agents, ALWAYS make a tool call (e.g. Bash echo) — NEVER end your turn with text-only while agents are pending. This prevents notification delivery stalls.
- On unrecoverable failure, report to user — never loop forever
- Track task status throughout: PENDING → IN_PROGRESS → GATES_PASS → APPROVED → MERGED

---
${phaseConfig(config)}
---
${phaseExplore()}
---
${phasePlan(config)}
---
${phaseEvaluate(config)}
---
${phaseApprove()}
---
${phaseImplement(config)}
---
${phaseGate()}
---
${phaseReview(config)}
---
${phaseMerge()}
---

## Start Now

Begin with Phase 0 — display the config table and ask for approval.
`
}

// Keep backward compat export name
export const buildOrchestratorPrompt = buildHarnessPrompt
