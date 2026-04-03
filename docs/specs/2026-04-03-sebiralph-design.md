# /sebiralph Design Spec

Dual-model orchestration: Claude (Anthropic) + Codex (OpenAI) collaborate on complex tasks. Claude plans and reviews, Codex implements, both run in parallel via per-agent provider routing.

## Core Types

```typescript
type ModelRef = {
  provider: 'anthropic' | 'openai'
  model: string // 'claude-opus-4-6' | 'gpt-5.4' | etc.
}

type AgentRunContext = {
  agentId: string
  role: RalphRole
  modelRef: ModelRef
  worktree?: string
}

type RalphRole = 'planner' | 'evaluator' | 'worker' | 'frontend' | 'reviewer'

type PRDTask = {
  id: string
  title: string
  description: string
  role: 'worker' | 'frontend'
  modelRef: ModelRef
  ownedPaths: string[]
  dependsOn: string[]       // task IDs
  inputs: string[]          // files/contracts this task reads
  outputs: string[]         // files this task creates/modifies
  acceptanceChecks: string[] // testable criteria
  wave: number              // 0 = contracts, 1+ = implementation
  status: 'pending' | 'in_progress' | 'review' | 'fix' | 'approved' | 'merged'
}

type RalphConfig = {
  planner: ModelRef
  evaluator: ModelRef
  worker: ModelRef
  frontend: ModelRef
  reviewer: ModelRef
}
```

## Default Config

| Role | Provider | Model | Why |
|------|----------|-------|-----|
| Planner | anthropic | claude-opus-4-6 | Best at architecture and planning |
| Evaluator | openai | gpt-5.4 | Different perspective, catches blind spots |
| Worker | openai | gpt-5.4 | Fast, capable at implementation |
| Frontend | anthropic | claude-sonnet-4-6 | Strong at UI/UX, CSS, design patterns |
| Reviewer | anthropic | claude-opus-4-6 | Thorough code review |

## Per-Agent Provider Routing (Core Change)

### Problem
`getAPIProvider()` reads global env var. Only one provider per session. Parallel agents with different providers race on `process.env`.

### Solution
Pass `ModelRef` through the agent runtime chain. Never mutate global env for provider selection.

**Files to change:**

1. **`source/src/services/api/client.ts`** — `getAnthropicClient()` gains optional `providerOverride` parameter:
   ```typescript
   export async function getAnthropicClient({
     providerOverride, // NEW: 'anthropic' | 'openai' | undefined
     ...existing
   })
   ```
   When set, `'openai'` routes to Codex adapter, `'anthropic'` routes to firstParty path. Takes precedence over `getAPIProvider()`.

2. **`source/src/tools/AgentTool/AgentTool.tsx`** — Agent input schema gains `provider` field:
   ```typescript
   provider?: 'anthropic' | 'openai'
   ```

3. **`source/src/tools/AgentTool/runAgent.ts`** — Passes `providerOverride` through `toolUseContext.options` to `queryModel`.

4. **`source/src/services/api/claude.ts`** — `Options` type gains `providerOverride`. `queryModel()` passes it to `getAnthropicClient()`.

5. **`source/src/tools/AgentTool/loadAgentsDir.ts`** — `AgentDefinition` gains `provider` field.

**Design constraint:** When `providerOverride` is not set, behavior is identical to current code. Zero regression risk for existing agents.

## Phase 0: Config Picker

When `/sebiralph` is invoked:

1. Show defaults, ask "Use defaults? [Y/n]"
2. If yes: proceed with defaults
3. If no: show role-by-role picker with available models from both providers

Available models per provider:
- **anthropic**: opus (claude-opus-4-6), sonnet (claude-sonnet-4-6), haiku (claude-haiku-4-5)
- **openai**: gpt-5.4, gpt-5.4-mini, gpt-5.3-codex, gpt-5.2-codex

Config stored in session state (not persisted to disk).

## Phase 1: Planning Loop

### Participants
- Planner (Claude Opus): writes plan
- Evaluator (Codex gpt-5.4): critiques plan

### Flow
```
Planner writes initial plan
  → Evaluator reviews against hard gates
  → If gates fail: Planner revises (max 3 iterations)
  → If same critique repeats 2x: escalate to user
  → If gates pass: plan approved
```

### Hard Gates (criteria-based, not score-based)
The evaluator checks:
- [ ] Every task has owned paths (no unowned files)
- [ ] Dependencies are explicit and acyclic
- [ ] Acceptance criteria are testable (can be verified by build/test/lint)
- [ ] Shared contract changes (types, API schema, DB) have a dedicated owner
- [ ] No unresolved assumptions (max 2 allowed, flagged)
- [ ] Wave assignment respects dependency order

If all gates pass, plan is approved. If evaluator has stylistic suggestions but gates pass, those are noted but don't block.

### Plan Output Format
Structured JSON plan containing:
```json
{
  "title": "Add auth system",
  "summary": "...",
  "tasks": [ PRDTask, PRDTask, ... ],
  "waves": [
    { "wave": 0, "type": "contracts", "taskIds": ["t1"] },
    { "wave": 1, "type": "implementation", "taskIds": ["t2", "t3", "t4"] },
    { "wave": 2, "type": "implementation", "taskIds": ["t5"] }
  ],
  "sharedContracts": {
    "types": "src/types/auth.ts",
    "apiSchema": "src/api/auth.routes.ts"
  }
}
```

## Phase 2: PRD Approval

1. Plan JSON rendered as readable markdown table for the user
2. Shows: tasks, waves, file ownership, dependencies, acceptance criteria
3. User approves or requests changes
4. On approval: proceed to Phase 3

## Phase 3: Swarm Implementation

### Wave Execution
```
Wave 0 (contracts/shared):
  → Single agent writes shared types, API schema, DB migrations
  → Build + type-check gate
  → Merge to integration branch

Wave 1 (parallel implementation):
  → Each task gets own agent + own git worktree
  → Worker tasks: Codex gpt-5.4 (provider: openai)
  → Frontend tasks: Claude Sonnet (provider: anthropic)
  → All agents start from integration branch (has Wave 0 merged)
  → Agents run in parallel (background tasks)

Wave 1 completion:
  → Deterministic gates per worktree: build, lint, type-check, test
  → Gates pass → queue for review
  → Gates fail → send error back to worker agent for fix (max 2 retries)

Wave 2+ (if dependencies on Wave 1):
  → Wave 1 merged to integration branch first
  → Same pattern as Wave 1
```

### Agent Isolation
- Each worker agent spawned via `AgentTool` with `isolation: 'worktree'`
- Worktree created from integration branch `ralph/integration-{sessionId}` (not main)
- `provider` field in agent call determines which API to use
- Agents have disjoint `ownedPaths` — no two agents write the same file

### Deterministic Gates (run before review)
Per worktree, before Claude review:
1. `git diff --stat` — verify only owned paths modified
2. Build: `npm run build` / `tsc --noEmit` (if applicable)
3. Lint: project linter (if configured)
4. Test: `npm test` / `pytest` (if applicable)

Failed gates → fix loop to worker (max 2 retries). Still failing → escalate to user.

## Phase 4: Review & Merge

### Flow
1. Automated gates pass (Phase 3)
2. Claude Opus reviews the diff (provider: anthropic)
   - Scope: only the owned paths for this task
   - Reviews against: acceptance criteria from PRD, code quality, security
3. If issues found: sends fix instructions back to original worker
   - Worker fixes in same worktree (same provider)
   - Re-run gates → re-review (max 2 cycles)
4. If approved: merge worktree to integration branch
5. After all tasks in wave merged: run full integration test
6. After all waves complete: show summary to user

### Review Scope Narrowing (avoid bottleneck)
- Reviewer only sees the diff, not entire codebase
- Automated gates handle build/lint/type errors
- Reviewer focuses on: logic, security, acceptance criteria
- Trivial formatting/style issues auto-fixed by linter, not reviewer

## File Structure

New files to create:
```
source/src/skills/sebiralph/
  index.ts              — Skill registration + orchestrator
  config.ts             — RalphConfig type + defaults + picker UI
  planner.ts            — Phase 1: planning loop logic
  prd.ts                — PRD types + JSON↔markdown rendering
  swarm.ts              — Phase 3: wave execution + agent dispatch
  reviewer.ts           — Phase 4: review + merge logic
  gates.ts              — Deterministic gate runner (build/lint/test)
  integration.ts        — Integration branch management
```

Modified files:
```
source/src/services/api/client.ts        — providerOverride param
source/src/services/api/claude.ts        — Options.providerOverride
source/src/tools/AgentTool/AgentTool.tsx — provider in input schema
source/src/tools/AgentTool/runAgent.ts   — pass provider through
source/src/tools/AgentTool/loadAgentsDir.ts — provider in definition
```

## Error Handling

| Failure | Response |
|---------|----------|
| Planner produces invalid plan | Evaluator rejects, loop continues |
| Planning loop hits max iterations | Escalate to user with current plan + critiques |
| Worker gate failure after 2 retries | Mark task failed, escalate to user |
| Review rejection after 2 fix cycles | Mark task needs-human, escalate |
| Merge conflict | Should not happen (disjoint paths). If it does: escalate |
| Provider API error (rate limit, auth) | Retry with backoff. After 3 failures: escalate |
| Worker modifies files outside ownedPaths | Gate catches this (git diff check), reject |

## Not In Scope (V1)

- Persisting RalphConfig to disk (session-only)
- Custom agent definitions beyond the 5 roles
- Cross-wave real-time communication between agents
- Automatic rollback on integration test failure
- Cost tracking/budgeting per agent
