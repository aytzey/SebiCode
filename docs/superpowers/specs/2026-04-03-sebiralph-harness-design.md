# SebiRalph Harness Flow Design

**Date**: 2026-04-03
**Status**: Approved
**Scope**: Transform `/sebiralph` from prompt-only skill to structured multi-phase harness flow with multi-provider swarm implementation

## Problem

SebiRalph currently generates a 35-line orchestrator prompt and hopes the AI follows it. 6 of 10 modules (gates, integration, swarm, planner, reviewer, prd) are dead code — exported but never imported or called. The skill is a prompt generator, not a harness.

## Solution

Rewrite the orchestrator to produce a **structured 8-phase harness prompt** that inlines content from all modules. The modules become the "source of truth" — their schemas, prompts, and gate definitions are imported and embedded into the harness prompt at invocation time.

**Skill mode**: `context: 'inline'` (runs in main conversation, allows user interaction for config and PRD approval).

## 2026-04-04 Addendum

- TDD is now **ON by default** for `/sebiralph` runs unless the user explicitly disables it in config review.
- Planning and validation now require explicit regression/spec/smoke acceptance checks for each task.
- Worker prompts now follow **red-green-refactor** when TDD is on.
- The final phase no longer ends at merge. It must **deploy the integrated branch, verify the live/runtime surface, and loop through fix → gate → review → redeploy** until gaps are closed or a real external blocker is confirmed.

## Architecture

```
/sebiralph "task description"
        |
        v
index.ts: getPromptForCommand(args)
  |-- config.ts -> formatConfigSummary()
  |-- planner.ts -> buildPlannerPrompt(), buildEvaluatorPrompt()
  |-- prd.ts -> PLAN_JSON_SCHEMA_PROMPT, renderPlanAsMarkdown()
  |-- swarm.ts -> buildWorkerPrompt()
  |-- reviewer.ts -> buildReviewPrompt(), buildFixPrompt()
  |-- gates.ts -> gate command definitions (inline)
  |-- integration.ts -> git command templates (inline)
        |
        v
  Structured harness prompt with 8 phases
  (each phase has entry/exit criteria, tool call templates, error handling)
```

Modules are not called at runtime. They are imported at skill invocation time and their content is inlined into the prompt. This means:
- JSON schemas defined once in `prd.ts`, automatically inlined
- Gate commands defined once in `gates.ts`, automatically inlined
- Subagent prompt templates defined once in `planner.ts`/`reviewer.ts`/`swarm.ts`, automatically inlined

## Phase Definitions

### Phase 0: Config Review

**Entry**: Skill invoked with task description.
**Action**: Display role-model assignment table. Ask user to approve or change.
**Exit**: User confirms config.
**Hard stop**: Yes — do not proceed until user approves.

Tool calls: None (text output only).

### Phase 1: Codebase Exploration

**Entry**: Config approved.
**Action**: Use Glob, Read, Grep to understand project structure. Produce a concise summary: language, framework, test setup, entry points, key directories.
**Exit**: `codebaseContext` string ready for Phase 2.

Tool calls: Glob, Read, Grep.

### Phase 2: Planning

**Entry**: `codebaseContext` ready.
**Action**: Spawn Planner subagent (Anthropic, Opus) with `buildPlannerPrompt(userTask, config, codebaseContext)`. Planner outputs JSON plan matching `PLAN_JSON_SCHEMA_PROMPT`. AI validates the returned JSON against `validatePlan()` criteria:
- Every task has `ownedPaths` (no unowned files)
- Dependencies are explicit and acyclic
- Acceptance criteria are testable
- Shared contract changes in wave 0
- Wave assignment respects dependency order

If validation fails (malformed JSON, missing fields), AI fixes inline (max 2 attempts).

**Exit**: Valid `RalphPlan` JSON.

Tool calls: Agent (provider: anthropic, model: opus).

### Phase 3: Evaluation

**Entry**: Valid plan JSON.
**Action**: Spawn Evaluator subagent (OpenAI) with `buildEvaluatorPrompt(planJson, userTask)`. Evaluator checks hard gates and returns `VERDICT: APPROVED` or `VERDICT: REJECTED` with fixes.

If rejected: spawn revision (Anthropic, Opus) with `buildRevisionPrompt(plan, feedback, iteration)`. Re-evaluate. Max 3 iterations.

If still rejected after 3 iterations: escalate to user with evaluator's feedback.

**Exit**: Plan approved by evaluator.

Tool calls: Agent (provider: openai), Agent (provider: anthropic) for revisions.

### Phase 4: PRD Approval

**Entry**: Plan approved by evaluator.
**Action**: Render plan as markdown table using `renderPlanAsMarkdown(plan)`. Display to user. Ask: "Approve this plan? [Y/n/edit]".
**Exit**: User approves.
**Hard stop**: Yes — do not proceed to implementation without user approval.

Tool calls: None (text output only).

### Phase 5: Swarm Implementation

**Entry**: User approved plan.
**Action**: Execute waves sequentially. Within each wave, spawn workers in parallel.

**Wave 0** (contracts/shared — sequential):
- Single Agent call with `isolation: "worktree"`
- Provider from `config.worker`
- No background (must complete before wave 1)

**Wave 1+** (implementation — parallel):
- Multiple simultaneous Agent calls
- Each with `isolation: "worktree"`, `run_in_background: true`
- Provider based on `task.role`: `frontend` tasks use `config.frontend.provider`, `worker` tasks use `config.worker.provider`
- Worker prompt from `buildWorkerPrompt(task, plan)`

**Exit**: All agents in wave completed.

Agent tool call template per worker:
```
Agent({
  description: "ralph-<role>: <task.title>",
  prompt: <buildWorkerPrompt output>,
  provider: "<config provider for role>",
  isolation: "worktree",
  run_in_background: true  // wave 1+ only
})
```

### Phase 6: Gate Validation

**Entry**: Worker agent completed.
**Action**: Per worker, run deterministic gates via Bash in the worker's worktree:

1. **Path ownership**: `git diff --name-only HEAD` — verify all changed files are within `task.ownedPaths`
2. **Build**: `npm run build --if-present` (or `npx tsc --noEmit` if tsconfig exists)
3. **Lint**: `npm run lint --if-present` (or `ruff check .` if pyproject.toml exists)
4. **Test**: `npm test --if-present` (or `pytest` if pytest.ini exists)

Gate fail: spawn fix agent in same worktree, re-run gates. Max 2 retries.

**Exit**: All gates pass for all workers in wave.

Tool calls: Bash (4 commands per worker).

### Phase 7: Review & Fix

**Entry**: All gates passed for a task.
**Action**: Get diff from worker's worktree, spawn Reviewer subagent (Anthropic, Opus) with `buildReviewPrompt(task, diffOutput)`.

Verdict parsing:
- `VERDICT: APPROVED` → task ready for merge
- `VERDICT: NEEDS_FIX` with issues → spawn fix agent with `buildFixPrompt(task, reviewFeedback)`, re-review. Max 2 cycles.

**Exit**: All tasks in wave reviewed and approved.

Tool calls: Bash (git diff), Agent (provider: anthropic, model: opus).

### Phase 8: Merge & Summary

**Entry**: All tasks reviewed and approved.
**Action**:
1. Create integration branch: `git branch ralph/integration-<sessionId>`
2. Per approved task: merge task branch into integration with `--no-ff`
3. Cleanup worktrees and task branches
4. Report: tasks completed, files changed, integration branch name

**Exit**: All work merged to integration branch, worktrees cleaned up.

Tool calls: Bash (git merge, git worktree remove, git branch -D).

## Files to Modify

| File | Change |
|------|--------|
| `orchestrator.ts` | Complete rewrite — build structured 8-phase harness prompt importing all modules |
| `index.ts` | Rewrite — import all modules, set `effort: 'max'`, build config phase at invocation |
| `planner.ts` | No change — used by orchestrator |
| `prd.ts` | No change — used by orchestrator |
| `swarm.ts` | No change — used by orchestrator |
| `reviewer.ts` | No change — used by orchestrator |
| `gates.ts` | No change — gate definitions inlined by orchestrator |
| `integration.ts` | No change — git commands inlined by orchestrator |
| `config.ts` | No change — config formatting used by index.ts |
| `types.ts` | No change — types used throughout |

Only 2 files need modification: `orchestrator.ts` (complete rewrite) and `index.ts` (rewrite registration).

## Error Handling

| Scenario | Action |
|----------|--------|
| Planner returns invalid JSON | AI fixes inline (max 2 attempts), then escalate to user |
| Evaluator rejects plan 3x | Show feedback to user, ask for guidance |
| Worker agent fails/crashes | Report error, skip task, continue wave |
| Gate fails after 2 fix attempts | Mark task as failed, report to user, continue |
| Reviewer rejects after 2 fix cycles | Mark task as needs-manual-review, continue |
| Git merge conflict | Report conflict details, ask user to resolve |
| No Claude credentials for Anthropic subagent | Fail early with clear message (pre-flight check in client.ts) |

## Success Criteria

1. All 10 sebiralph modules are used (no dead code)
2. Multi-provider routing works: planner/reviewer on Anthropic, workers on OpenAI
3. Workers run in isolated worktrees in parallel
4. User has two approval gates: config (Phase 0) and PRD (Phase 4)
5. Deterministic gate validation (build/lint/test/path-ownership) runs after each worker
6. Integration branch created with all approved work merged
