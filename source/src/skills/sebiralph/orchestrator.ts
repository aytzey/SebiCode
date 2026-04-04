/**
 * SebiRalph Harness Orchestrator
 *
 * Builds a structured 8-phase harness prompt that inlines content from all
 * sebiralph modules. The AI follows this prompt deterministically, making
 * tool calls at each phase with exact templates provided.
 *
 * Modules used:
 *  - config.ts   → role-model display, workflow defaults display
 *  - planner.ts  → planner/evaluator prompt templates, hard gates
 *  - prd.ts      → JSON schema, plan validation criteria, markdown render
 *  - swarm.ts    → worker prompt template
 *  - reviewer.ts → review prompt template, fix prompt template
 *  - gates.ts    → deterministic gate commands
 *  - integration.ts → git worktree/branch commands
 */

import type {
  RalphConfig,
  RalphRuntimeContext,
  RalphWorkflowDefaults,
} from './types.js'
import { formatConfigSummary, formatWorkflowSummary } from './config.js'
import { PLAN_JSON_SCHEMA_PROMPT } from './prd.js'
import { HARD_GATES } from './planner.js'

function phaseConfig(
  config: RalphConfig,
  workflow: RalphWorkflowDefaults,
): string {
  return `
## PHASE 0 — Config Review ${workflow.loopMode ? '✦ AUTO-CONTINUE IN LOOP MODE' : '✦ HARD STOP'}

Current role assignments:
${formatConfigSummary(config)}

Execution defaults:
${formatWorkflowSummary(workflow)}

TDD default meaning:
- Workers start with a failing regression/spec first, then implement the minimal fix, then refactor
- The harness does NOT declare success while TDD is ON until the final integrated change is deployed and runtime-verified
- If deploy/runtime verification exposes a gap, the harness re-enters a fix loop until the gap is closed or a real external blocker is proven

Loop mode meaning:
- ${workflow.loopMode ? `LOOP MODE IS ON for this run. After a successful deploy/runtime verification pass, the harness must critique the result, identify any material code/UX/reliability/performance gaps, and launch another refinement round until the quality bar is met or ${workflow.maxQualityLoops} refinement loops are used.` : 'Loop mode is OFF for this run. The harness may stop after the first deploy/runtime verification pass.'}

Display the config and workflow defaults to the user and ask:
> "SebiRalph config above. TDD is ON by default.${workflow.loopMode ? ' Loop mode is also ON for this run.' : ''} Approve? Reply **yes** to proceed, **role=N** to change a model, or **tdd=off** to disable the default TDD workflow for this run."

${workflow.loopMode
  ? `In loop mode, the current config is PRE-APPROVED. Briefly display the defaults, note that the user can still interrupt with overrides, then continue immediately to Phase 1. Only stop here if the user explicitly requested config changes in the current conversation.`
  : `**DO NOT proceed to Phase 1 until the user explicitly approves.**
If the user disables TDD, restate that deploy verification becomes optional for this run and ask for confirmation again.`}
`
}

function phaseExplore(): string {
  return `
## PHASE 1 — Codebase Exploration

**Entry:** Config approved.
**Goal:** Build two artifacts for the Planner:
1. \`codebaseContext\`
2. \`deliveryContext\`

Use these tools:
1. \`Glob("**/*.{ts,tsx,js,jsx,py,go,rs,java,yml,yaml,json,md}")\` — file tree
2. \`Read(package.json)\`, \`Read(pyproject.toml)\`, \`Read(Makefile)\`, \`Read(docker-compose.yml)\` if present
3. \`Read(tsconfig.json)\` / build config equivalents if present
4. \`Read(CLAUDE.md)\`, \`Read(README.md)\`, deploy docs, runbooks, and CI workflow files
5. \`Grep("deploy|release|preview|staging|production|smoke|health")\` on docs/manifests/workflows
6. \`Grep("test|spec|vitest|jest|pytest|playwright|cypress")\` on package manifests and key directories

Produce \`codebaseContext\` with:
- Language & framework
- Directory structure (key dirs only)
- Test setup (runner, config file, test dirs, naming conventions)
- Build system
- Entry points

Produce \`deliveryContext\` with:
- \`deployCommand\`: exact command from docs/scripts if discoverable
- \`verifyCommand\`: exact smoke/e2e/runtime command if discoverable
- \`runtimeSurface\`: URL, CLI entrypoint, UI route, API endpoint, or other observable surface
- \`rollbackHint\`: documented rollback/undeploy path, or "none documented"
- \`sources\`: where the deploy/verify expectations came from

If TDD is ON and you cannot derive a credible deploy/runtime verification path, set:
\`deliveryContext.status = "NEEDS_USER_DEPLOY_INPUT"\`
and carry that forward. **Do not invent deploy commands.**

**Exit:** \`codebaseContext\` and \`deliveryContext\` are ready. Move to Phase 2.
`
}

function phasePlan(
  config: RalphConfig,
  workflow: RalphWorkflowDefaults,
): string {
  return `
## PHASE 2 — Planning (Planner Subagent)

**Entry:** \`codebaseContext\` and \`deliveryContext\` ready from Phase 1.

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

Build the prompt by filling in {TASK}, {CODEBASE_CONTEXT}, {DELIVERY_CONTEXT}, and {CONFIG}:

\`\`\`
You are the Planner. Create a detailed implementation plan.

## Task
{TASK}

## Codebase Context
{CODEBASE_CONTEXT}

## Delivery Context
{DELIVERY_CONTEXT}

## Role Assignments
${formatConfigSummary(config)}

## Workflow Defaults
TDD: ${workflow.tdd ? 'ON' : 'OFF'}
Deploy verification: ${workflow.deployVerification ? 'REQUIRED when TDD is ON' : 'OPTIONAL'}
Loop mode: ${workflow.loopMode ? `ON (${workflow.maxQualityLoops} refinement loops max)` : 'OFF'}

## Instructions
1. Break the work into discrete tasks with clear boundaries
2. Assign role: "worker" (backend/infra) or "frontend" (UI)
3. Identify shared contracts (types, API schema, DB) — these go in wave 0
4. Assign waves respecting dependencies
5. TDD is ${workflow.tdd ? 'ON by default' : 'OFF for this run'}. ${workflow.tdd ? 'Plan red-green-refactor work, not code-first work.' : 'Still keep verification explicit.'}
6. For each task define: ownedPaths (disjoint within wave), dependsOn, inputs, outputs, acceptanceChecks
7. Every task must include at least one explicit acceptance check that names the regression/spec/smoke coverage to add or update
8. Final-wave tasks must include the deploy/runtime verification expectations from DELIVERY_CONTEXT when a deployable surface exists
9. Set modelRef for each task: worker tasks → { provider: "${config.worker.provider}", model: "${config.worker.model}" }, frontend tasks → { provider: "${config.frontend.provider}", model: "${config.frontend.model}" }

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
5. Check: every task has at least one explicit test/regression/smoke acceptance check
6. Check: shared contract tasks are in wave 0
7. Check: within each wave, no two tasks share overlapping owned paths
8. Check: final-wave tasks mention deploy/runtime verification when DELIVERY_CONTEXT includes a deployable surface
9. ${workflow.loopMode ? 'Check: the plan leaves room for at least one refinement pass after the first deploy instead of treating first-pass deploy success as the terminal quality bar.' : 'No explicit loop-mode planning required for this run.'}

If validation fails, show errors and ask Planner to revise. Max 2 fix attempts.

**Exit:** Valid plan JSON. Move to Phase 3.
`
}

function phaseEvaluate(
  config: RalphConfig,
  workflow: RalphWorkflowDefaults,
): string {
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

## Delivery Context
{DELIVERY_CONTEXT}

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
  description: "ralph-planner: revise plan (iteration N/${workflow.maxPlanIterations})",
  prompt: "You are the Planner. Evaluator rejected your plan (iteration N/${workflow.maxPlanIterations}).\\n\\n## Previous Plan\\n{PLAN_JSON}\\n\\n## Delivery Context\\n{DELIVERY_CONTEXT}\\n\\n## Feedback\\n{EVALUATOR_RESPONSE}\\n\\nRevise to address ALL feedback. Output ONLY the revised JSON plan.",
  provider: "${config.planner.provider}",
  model: "opus"
})
\`\`\`

Re-evaluate with the revised plan. **Max ${workflow.maxPlanIterations} iterations.**
If still rejected after ${workflow.maxPlanIterations} iterations → show the evaluator's feedback to the user and ask for guidance.

**Exit:** Plan approved by evaluator. Move to Phase 4.
`
}

function phaseApprove(workflow: RalphWorkflowDefaults): string {
  return `
## PHASE 4 — PRD Approval ${workflow.loopMode ? '✦ AUTO-CONTINUE IN LOOP MODE' : '✦ HARD STOP'}

**Entry:** Plan approved by evaluator.

Render the plan as a markdown table. For each wave, show:

| ID | Title | Role | Provider/Model | Owned Paths | Depends On | Acceptance Criteria |

Then display a short delivery summary:
- TDD: ${workflow.tdd ? 'ON by default' : 'OFF for this run'}
- Deploy verification: ${workflow.deployVerification ? 'required when TDD is ON' : 'optional'}
- Loop mode: ${workflow.loopMode ? `ON (${workflow.maxQualityLoops} refinement loops max)` : 'OFF'}
- Delivery context: deploy command / runtime surface / verification command / rollback hint

If \`deliveryContext.status = "NEEDS_USER_DEPLOY_INPUT"\`, stop and ask the user for the missing deploy/runtime verification path before implementation starts.

Then ask the user:
> "Implementation plan above. TDD is ${workflow.tdd ? 'ON' : 'OFF'} for this run. Approve? Reply **Y** to start implementation, **n** to reject, or **edit** with changes."

${workflow.loopMode
  ? `In loop mode, the PRD is PRE-APPROVED after you display it. Continue directly into implementation unless deploy/runtime input is missing or the user explicitly interrupted with edits.`
  : `**DO NOT proceed to Phase 5 until the user explicitly approves.**
If user requests edits, modify the plan and re-display.`}

**Exit:** User approves. Move to Phase 5.
`
}

function phaseImplement(
  config: RalphConfig,
  workflow: RalphWorkflowDefaults,
): string {
  const tddBlock = workflow.tdd
    ? `## TDD Workflow
1. Add or update the regression/spec that proves the task is incomplete
2. Run that test first and observe the failure
3. Implement the smallest change that makes the failing test pass
4. Refactor only after the new/updated tests pass again`
    : '## Verification Workflow\nKeep verification explicit in the worktree before committing.'

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

After receiving a background agent notification, ALWAYS make a tool call — never respond with text-only.
Pattern:
1. Receive task-notification → update your status tracking
2. Check: are ALL agents in this wave done?
   - **YES** → immediately proceed to Phase 6
   - **NO** → run \`Bash("echo 'Waiting for N remaining agents...'")\`
3. After the Bash result, check if more notifications arrived. Repeat until all done.

### Provider Fallback

If an Agent call with \`provider: "openai"\` fails (model not found, auth error), immediately retry with \`provider: "anthropic", model: "sonnet"\`. If the FIRST worker in a wave fails on openai, switch ALL remaining workers in that wave to anthropic.
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

${tddBlock}

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

function phaseGate(workflow: RalphWorkflowDefaults): string {
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
cd {worktree_path} && npm test --if-present || test -f pytest.ini && pytest || echo "no test runner"
\`\`\`

### TDD Audit

When TDD is ON:
- Inspect the diff file list from Gate 1
- If the task changes runtime behavior and no test/spec/regression file was added or updated, treat that as a gate failure unless the plan explicitly marked the task as docs-only or non-runtime work

### Gate Failure Handling

If ANY gate or the TDD audit fails:
1. Spawn a fix agent in the SAME worktree:
\`\`\`
Agent({
  description: "ralph-fix: {task.title} gate failure",
  prompt: "Gate '{gate_name}' failed for task '{task.title}'.\\n\\nError output:\\n{gate_output}\\n\\nOwned paths: {ownedPaths}\\n\\n${workflow.tdd ? 'Keep TDD on: add or preserve the failing regression first, then fix it.' : 'Fix the issue directly.'}\\nStay within owned paths. Commit the fix.",
  provider: "{same provider as original worker}",
  cwd: "{worktree_path}"
})
\`\`\`
2. Re-run all 4 gates and the TDD audit
3. **Max ${workflow.maxGateFixAttempts} fix attempts.** After that, mark task as GATE_FAILED and report to user.

**Exit:** All gates pass for all tasks in this wave. Move to Phase 7.
`
}

function phaseReview(
  config: RalphConfig,
  workflow: RalphWorkflowDefaults,
): string {
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

Focus on: logic, security, acceptance criteria, and regression coverage.
${workflow.tdd ? 'TDD is ON. If behavior changed without corresponding regression/spec updates, that is a real issue.' : 'Do NOT flag missing tests unless the acceptance criteria require them.'}

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
  prompt: "Reviewer found issues with '{task.title}'.\\n\\n## Feedback\\n{reviewer_response}\\n\\n## Owned Paths: {ownedPaths}\\n\\n${workflow.tdd ? 'Preserve or add the regression that proves the issue, then fix it.' : 'Fix ONLY the identified issues.'}\\nStay within owned paths. Commit the fix.",
  provider: "{same provider as original worker}",
  cwd: "{worktree_path}"
})
\`\`\`

Then re-run gates (Phase 6) and re-review. **Max ${workflow.maxReviewFixCycles} fix cycles.**
After that, mark as NEEDS_MANUAL_REVIEW and continue.

**Exit:** All tasks reviewed. Move to Phase 8.
`
}

function phaseMerge(workflow: RalphWorkflowDefaults): string {
  return `
## PHASE 8 — Merge, Deploy & Verify

**Entry:** All tasks reviewed and approved (or marked for manual review).

### Step 1: Create integration branch
\`\`\`bash
git branch ralph/integration-$(date +%s | cut -c1-8)
\`\`\`

Immediately after choosing the branch name, emit the integration marker using the same \`run_id\` from the Progress Marker Protocol:
\`<sebiralph-integration run_id="{current_run_id}" branch="{integration_branch}" />\`

### Step 2: Merge each approved task
For each APPROVED task (skip GATE_FAILED and NEEDS_MANUAL_REVIEW):
\`\`\`bash
git checkout ralph/integration-{id}
git merge --no-ff -m "ralph: merge task {task.id} — {task.title}" {task_branch}
git checkout {original_branch}
\`\`\`

The task branch name is available from the Agent tool's worktree result.

### Step 3: Deploy the integrated branch

When TDD is ON, deployment is REQUIRED unless the user explicitly disabled TDD.
- Use \`deliveryContext.deployCommand\` from Phase 1
- If \`deliveryContext.status = "NEEDS_USER_DEPLOY_INPUT"\`, stop and ask the user instead of guessing
- Record the deploy target, commit SHA, and any preview/staging URL returned by the deploy command
- Emit a deploy marker for each attempt:
  - Before running deploy: \`<sebiralph-deploy run_id="{current_run_id}" status="pending" target="{deploy_target_or_blank}" url="{deploy_url_or_blank}" />\`
  - On deploy failure/blocker: \`<sebiralph-deploy run_id="{current_run_id}" status="failed|blocked" target="{deploy_target_or_blank}" url="{deploy_url_or_blank}" />\`

### Step 4: Runtime verification of the deployed change

Use the real runtime surface from \`deliveryContext.runtimeSurface\`.

Prefer a verification subagent if the Agent tool exposes it:
\`\`\`
Agent({
  description: "ralph-verifier: deployed integration branch",
  subagent_type: "verification",
  prompt: "Original task: {TASK}\\nIntegration branch: {integration_branch}\\nDeploy target: {deploy_target}\\nRuntime surface: {runtime_surface}\\nVerify the deployed change end-to-end and try to break it. Include at least one adversarial probe."
})
\`\`\`

If the verification subagent is unavailable, perform equivalent runtime verification yourself.
Minimum requirement:
- Run the documented smoke/e2e/runtime command or hit the live surface directly
- Capture the evidence
- Run at least one adversarial probe
- After the verdict is known, emit:
  - Pass: \`<sebiralph-deploy run_id="{current_run_id}" status="passed" target="{deploy_target_or_blank}" url="{deploy_url_or_blank}" />\`
  - Fail/block: \`<sebiralph-deploy run_id="{current_run_id}" status="failed|blocked" target="{deploy_target_or_blank}" url="{deploy_url_or_blank}" />\`

### Step 5: Deploy fix loop

If deploy OR runtime verification fails and TDD is ON:
1. Create a fresh fix worktree from the integration branch
2. Add or preserve the failing regression that proves the deploy/runtime gap
3. Fix the issue in that worktree
4. Re-run Phase 6 and Phase 7 on the fix
5. Merge the fix back into the integration branch
6. Re-deploy
7. Re-run runtime verification

Repeat until deploy verification passes or you hit **${workflow.maxDeployFixCycles} deploy fix cycles**.
If still failing after ${workflow.maxDeployFixCycles} cycles, stop and report the blocker with the latest deploy/verification evidence.

### Step 5B: Quality refinement loop ${workflow.loopMode ? '(REQUIRED for this run)' : '(optional / skip by default)'}

${workflow.loopMode
  ? `When deploy verification passes, do NOT immediately stop. Run a quality audit against the integrated diff and the deployed surface.

Spawn a reviewer-quality pass:
\`\`\`
Agent({
  description: "ralph-quality: critique deployed result",
  prompt: "Original task: {TASK}\\nIntegration branch: {integration_branch}\\nDeployed surface: {runtime_surface}\\nRecent merged diff summary: {diff_summary}\\nJudge the shipped result against a high bar: correctness, maintainability, test coverage, edge-case handling, UX polish, performance, and operational safety. Treat 'good enough' as a REFINE verdict. Only output QUALITY_VERDICT: SHIP_IT when the result is genuinely strong and you would be comfortable shipping it without apology. Otherwise output QUALITY_VERDICT: REFINE plus a short ranked improvement backlog with deploy-visible wins first."
})
\`\`\`

Handling:
1. Before recording the verdict, compute the current refinement iteration number and emit a loop marker:
   - Refine: \`<sebiralph-loop run_id="{current_run_id}" iteration="{quality_iteration}" verdict="refine" />\`
   - Ship it: \`<sebiralph-loop run_id="{current_run_id}" iteration="{quality_iteration}" verdict="ship_it" />\`
   - Limit reached: \`<sebiralph-loop run_id="{current_run_id}" iteration="{quality_iteration}" verdict="limit_reached" />\`
2. If \`QUALITY_VERDICT: SHIP_IT\`, proceed to cleanup and final report
3. If \`QUALITY_VERDICT: REFINE\`, create a focused refinement mini-plan with at most 3 tasks, then return to Phase 5 → 6 → 7 → 8 using the same run and integration branch
4. Re-deploy and re-verify after each refinement round
5. Keep looping until \`SHIP_IT\` or you hit **${workflow.maxQualityLoops} refinement loops**
6. If the loop limit is hit, stop and report what remains instead of claiming perfection`
  : `If the user explicitly asks for more polish after a successful deploy, you may run one extra critique pass. Otherwise continue to cleanup.`}
### Step 6: Cleanup

After successful deployment verification (or after final escalation), clean up:
\`\`\`bash
git worktree remove {worktree_path} --force
git branch -D ralph/task-{task.id}
\`\`\`

### Step 7: Final Report

Output a summary table:

| Task | Status | Files Changed | Branch |
|------|--------|---------------|--------|

Then report:
- Integration branch
- Deploy target / URL
- Runtime verification verdict
- Number of deploy fix cycles used

Final message:
> "SebiRalph complete. Integration branch: \`ralph/integration-{id}\`. Deploy verification: {PASS|FAIL|BLOCKED}. {N} tasks merged, {M} failed/manual."

If any tasks were GATE_FAILED or NEEDS_MANUAL_REVIEW, list them with details.
`
}

function buildProgressProtocol(runtime?: RalphRuntimeContext): string {
  if (!runtime) {
    return ''
  }

  return `
## Run Metadata
- SebiRalph run id: ${runtime.runId}
${runtime.sessionId ? `- Session id: ${runtime.sessionId}` : ''}

## Progress Marker Protocol
Emit a standalone progress marker whenever you enter a phase or reach a hard stop.
Use this exact shape:
- Entered phase: <sebiralph-progress run_id="${runtime.runId}" phase="{phase_id}" status="entered" />
- Waiting for user: <sebiralph-progress run_id="${runtime.runId}" phase="{phase_id}" status="awaiting_user" />
- Phase completed: <sebiralph-progress run_id="${runtime.runId}" phase="{phase_id}" status="completed" />
- Final success: <sebiralph-progress run_id="${runtime.runId}" phase="completed" status="completed" />
- Hard blocker: <sebiralph-progress run_id="${runtime.runId}" phase="blocked" status="blocked" />
- Integration branch selected: <sebiralph-integration run_id="${runtime.runId}" branch="{integration_branch}" />
- Deploy status update: <sebiralph-deploy run_id="${runtime.runId}" status="{pending|passed|failed|blocked}" target="{deploy_target_or_blank}" url="{deploy_url_or_blank}" />
- Quality loop verdict: <sebiralph-loop run_id="${runtime.runId}" iteration="{quality_iteration}" verdict="{refine|ship_it|limit_reached}" />

Allowed phase ids:
config_review, explore, plan, evaluate, prd_approval, wave_execution, gate_validation, review_fix, integration_merge, deploy_verify, completed, blocked

Keep the markers short and exact. Use empty strings for unknown target/url values, and do not place literal double quotes inside marker attribute values. They are used for harness durability and resume.`
}

export function buildHarnessPrompt(
  userTask: string,
  config: RalphConfig,
  workflow: RalphWorkflowDefaults,
  runtime?: RalphRuntimeContext,
): string {
  return `# /sebiralph — Multi-Provider Swarm Harness

You are the SebiRalph orchestrator. Execute this task using a structured 8-phase workflow with multi-provider AI agents.

## Task
${userTask}

${buildProgressProtocol(runtime)}

## Workflow Rules
- Execute phases IN ORDER (0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8)
- ${workflow.loopMode ? 'Phases 0 and 4 are pre-approved checkpoints in loop mode. Display them, then continue unless missing deploy input or the user explicitly interrupts.' : 'Phases 0 and 4 are HARD STOPS — wait for user approval'}
- Always set the \`provider\` field on Agent calls — it routes to the correct AI model
- Workers MUST use \`isolation: "worktree"\` for code isolation
- Wave 1+ workers MUST use \`run_in_background: true\` for parallel execution
- **TDD DEFAULT**: TDD is ON unless the user explicitly turns it off in Phase 0
- **DONE MEANS DEPLOYED**: When TDD is ON, do not declare success until the integrated change is deployed and runtime-verified
- **LOOP MODE**: ${workflow.loopMode ? `Enabled. After the first successful deploy/verify pass, keep refining and redeploying until the quality audit says SHIP_IT or ${workflow.maxQualityLoops} refinement loops are exhausted.` : 'Disabled unless the user explicitly asks for another refinement round.'}
- **KEEP-ALIVE**: When waiting for background agents, ALWAYS make a tool call — NEVER end your turn with text-only while agents are pending
- On unrecoverable failure, report to user — never loop forever
- Track task status throughout: PENDING → IN_PROGRESS → GATES_PASS → APPROVED → MERGED → DEPLOY_VERIFIED

---
${phaseConfig(config, workflow)}
---
${phaseExplore()}
---
${phasePlan(config, workflow)}
---
${phaseEvaluate(config, workflow)}
---
${phaseApprove(workflow)}
---
${phaseImplement(config, workflow)}
---
${phaseGate(workflow)}
---
${phaseReview(config, workflow)}
---
${phaseMerge(workflow)}
---

## Start Now

Begin with Phase 0 — display the config table and ask for approval.
`
}

export const buildOrchestratorPrompt = buildHarnessPrompt
