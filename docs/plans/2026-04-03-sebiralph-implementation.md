# /sebiralph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dual-model orchestration skill that uses Claude for planning/review and Codex for implementation, running in parallel with per-agent provider routing.

**Architecture:** Per-agent `providerOverride` piped through the options chain lets parallel subagents use different API providers without race conditions. A 4-phase orchestrator (plan → PRD → swarm → review) coordinates the agents.

**Tech Stack:** TypeScript, Zod schemas, Ink (React CLI), git worktrees, existing AgentTool infrastructure.

---

## File Map

### New Files
```
source/src/skills/sebiralph/
  types.ts          — ModelRef, RalphConfig, PRDTask, RalphPlan types
  config.ts         — Default config + interaktif picker
  orchestrator.ts   — Main 4-phase orchestrator
  planner.ts        — Phase 1: planning loop (planner + evaluator agents)
  prd.ts            — PRD JSON↔markdown rendering + validation
  swarm.ts          — Phase 3: wave dispatch + parallel agent management
  reviewer.ts       — Phase 4: review loop + merge
  gates.ts          — Deterministic gate runner (build/lint/test/path-check)
  integration.ts    — Integration branch create/merge/cleanup
  index.ts          — Bundled skill registration
```

### Modified Files
```
source/src/services/api/client.ts:88-100        — providerOverride param
source/src/services/api/claude.ts:681-712        — Options.providerOverride
source/src/tools/AgentTool/AgentTool.tsx:82-88   — provider in input schema
source/src/tools/AgentTool/runAgent.ts:340-345   — pass provider to options
source/src/tools/AgentTool/loadAgentsDir.ts:106  — provider in BaseAgentDefinition
source/src/skills/bundledSkills.ts               — import sebiralph registration
```

---

### Task 1: Core Types

**Files:**
- Create: `source/src/skills/sebiralph/types.ts`

- [ ] **Step 1: Create types file with all shared types**

```typescript
// source/src/skills/sebiralph/types.ts

export type ModelRef = {
  provider: 'anthropic' | 'openai'
  model: string
}

export type RalphRole = 'planner' | 'evaluator' | 'worker' | 'frontend' | 'reviewer'

export type RalphConfig = Record<RalphRole, ModelRef>

export const DEFAULT_CONFIG: RalphConfig = {
  planner:   { provider: 'anthropic', model: 'claude-opus-4-6' },
  evaluator: { provider: 'openai',    model: 'gpt-5.4' },
  worker:    { provider: 'openai',    model: 'gpt-5.4' },
  frontend:  { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  reviewer:  { provider: 'anthropic', model: 'claude-opus-4-6' },
}

export type PRDTaskStatus = 'pending' | 'in_progress' | 'review' | 'fix' | 'approved' | 'merged'

export type PRDTask = {
  id: string
  title: string
  description: string
  role: 'worker' | 'frontend'
  modelRef: ModelRef
  ownedPaths: string[]
  dependsOn: string[]
  inputs: string[]
  outputs: string[]
  acceptanceChecks: string[]
  wave: number
  status: PRDTaskStatus
}

export type WaveDefinition = {
  wave: number
  type: 'contracts' | 'implementation'
  taskIds: string[]
}

export type RalphPlan = {
  title: string
  summary: string
  tasks: PRDTask[]
  waves: WaveDefinition[]
  sharedContracts: Record<string, string>
}

export type GateResult = {
  passed: boolean
  gate: string
  output: string
}

export type ReviewResult = {
  approved: boolean
  issues: string[]
  fixInstructions?: string
}
```

- [ ] **Step 2: Commit**

```bash
git add source/src/skills/sebiralph/types.ts
git commit -m "feat(sebiralph): add core types — ModelRef, RalphConfig, PRDTask, RalphPlan"
```

---

### Task 2: Per-Agent Provider Override — client.ts

**Files:**
- Modify: `source/src/services/api/client.ts:88-100`

- [ ] **Step 1: Add `providerOverride` to `getAnthropicClient` signature**

At line 88, change the function signature to:

```typescript
export async function getAnthropicClient({
  apiKey,
  maxRetries,
  model,
  fetchOverride,
  source,
  providerOverride,
}: {
  apiKey?: string
  maxRetries: number
  model?: string
  fetchOverride?: ClientOptions['fetch']
  source?: string
  providerOverride?: 'anthropic' | 'openai'
}): Promise<Anthropic> {
```

- [ ] **Step 2: Add provider resolution logic before the existing Codex check**

Find the existing Codex early-return block (currently at ~line 132):
```typescript
  // Codex: use local ~/.codex/auth.json OAuth tokens, skip Anthropic auth
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_CODEX)) {
```

Replace it with:
```typescript
  // Per-agent provider override OR global env var
  const useCodex = providerOverride === 'openai' ||
    (providerOverride === undefined && isEnvTruthy(process.env.CLAUDE_CODE_USE_CODEX))
  const useAnthropic = providerOverride === 'anthropic'

  if (useCodex) {
    const { OpenAIAdapter } = await import('./openai-adapter.js')
    return new OpenAIAdapter({
      timeout: parseInt(process.env.API_TIMEOUT_MS || String(600 * 1000), 10),
    }) as unknown as Anthropic
  }

  // If explicitly anthropic, skip Codex even if env var is set
  // (fall through to normal Anthropic path below)
```

Remove the old `if (isEnvTruthy(process.env.CLAUDE_CODE_USE_CODEX))` block entirely — it's now handled above.

- [ ] **Step 3: Verify Anthropic path still works**

Run: `cd /home/dkmserver/Desktop/Machinity/aytug/sebi-code && node dist/cli.js --version`
Expected: `2.1.88 (Claude Code)`

- [ ] **Step 4: Commit**

```bash
git add source/src/services/api/client.ts
git commit -m "feat(sebiralph): add providerOverride to getAnthropicClient — per-agent routing"
```

---

### Task 3: Per-Agent Provider Override — claude.ts Options

**Files:**
- Modify: `source/src/services/api/claude.ts:681-712`

- [ ] **Step 1: Add `providerOverride` to `Options` type**

In the `Options` type (line ~681), add after `taskBudget`:

```typescript
  /** Per-agent provider override. When set, routes to the specified provider
   * regardless of the global CLAUDE_CODE_USE_CODEX env var. Used by sebiralph
   * to run Claude and Codex agents in parallel. */
  providerOverride?: 'anthropic' | 'openai'
```

- [ ] **Step 2: Pass `providerOverride` to `getAnthropicClient`**

Find the `getAnthropicClient` call in `queryModel` (~line 1786):

```typescript
        getAnthropicClient({
          maxRetries: 0,
          model: options.model,
          fetchOverride: options.fetchOverride,
          source: options.querySource,
        }),
```

Change to:

```typescript
        getAnthropicClient({
          maxRetries: 0,
          model: options.model,
          fetchOverride: options.fetchOverride,
          source: options.querySource,
          providerOverride: options.providerOverride,
        }),
```

- [ ] **Step 3: Commit**

```bash
git add source/src/services/api/claude.ts
git commit -m "feat(sebiralph): pipe providerOverride through Options to getAnthropicClient"
```

---

### Task 4: Per-Agent Provider Override — AgentTool + runAgent

**Files:**
- Modify: `source/src/tools/AgentTool/AgentTool.tsx:82-88`
- Modify: `source/src/tools/AgentTool/loadAgentsDir.ts:106-133`
- Modify: `source/src/tools/AgentTool/runAgent.ts:340-345`

- [ ] **Step 1: Add `provider` to `BaseAgentDefinition`**

In `loadAgentsDir.ts` line 106, add to `BaseAgentDefinition`:

```typescript
  /** API provider override. 'anthropic' = Anthropic API, 'openai' = Codex/OpenAI.
   * When set, subagent uses this provider regardless of session-level setting. */
  provider?: 'anthropic' | 'openai'
```

- [ ] **Step 2: Add `provider` to AgentTool input schema**

In `AgentTool.tsx` line 82, update `baseInputSchema`:

```typescript
const baseInputSchema = lazySchema(() => z.object({
  description: z.string().describe('A short (3-5 word) description of the task'),
  prompt: z.string().describe('The task for the agent to perform'),
  subagent_type: z.string().optional().describe('The type of specialized agent to use for this task'),
  model: z.enum(['sonnet', 'opus', 'haiku']).optional().describe("Optional model override for this agent."),
  provider: z.enum(['anthropic', 'openai']).optional().describe("API provider override. 'anthropic' = Claude, 'openai' = Codex/OpenAI."),
  run_in_background: z.boolean().optional().describe('Set to true to run this agent in the background.')
}));
```

- [ ] **Step 3: Pass provider through runAgent to options**

In `runAgent.ts`, find where options are assembled for the subagent query. The `toolUseContext.options` object is constructed/cloned for the subagent. Find where `model` is set on the options and add `providerOverride` alongside it.

Search for where `resolvedAgentModel` is used to set the options. Add:

```typescript
  // Resolve provider: tool call override > agent definition > undefined (inherit session)
  const resolvedProvider = override?.providerOverride ?? agentDefinition.provider
```

Then wherever the subagent's options are spread/constructed, include:

```typescript
  providerOverride: resolvedProvider,
```

This should be near where `model: resolvedAgentModel` is set in the options object passed to the query function.

- [ ] **Step 4: Build and verify both modes**

```bash
cd /home/dkmserver/Desktop/Machinity/aytug/sebi-code
export PATH="$HOME/.bun/bin:$PATH"
rm -f .cache/workspace/.prepared.json
node scripts/build-cli.mjs --no-minify

# Test Anthropic mode
node dist/cli.js -p "Say hi" 2>&1

# Test Codex mode
CLAUDE_CODE_USE_CODEX=1 node dist/cli.js -p "Say hi" 2>&1
```

Expected: Both modes respond normally.

- [ ] **Step 5: Commit**

```bash
git add source/src/tools/AgentTool/
git commit -m "feat(sebiralph): add provider field to AgentDefinition and AgentTool input schema"
```

---

### Task 5: Config Picker

**Files:**
- Create: `source/src/skills/sebiralph/config.ts`

- [ ] **Step 1: Create config module with defaults and picker**

```typescript
// source/src/skills/sebiralph/config.ts
import type { RalphConfig, RalphRole, ModelRef } from './types.js'
import { DEFAULT_CONFIG } from './types.js'

const AVAILABLE_MODELS: { label: string; ref: ModelRef }[] = [
  { label: 'Claude Opus 4.6',   ref: { provider: 'anthropic', model: 'claude-opus-4-6' } },
  { label: 'Claude Sonnet 4.6', ref: { provider: 'anthropic', model: 'claude-sonnet-4-6' } },
  { label: 'Claude Haiku 4.5',  ref: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' } },
  { label: 'GPT-5.4',           ref: { provider: 'openai',    model: 'gpt-5.4' } },
  { label: 'GPT-5.4 Mini',      ref: { provider: 'openai',    model: 'gpt-5.4-mini' } },
  { label: 'GPT-5.3 Codex',     ref: { provider: 'openai',    model: 'gpt-5.3-codex' } },
  { label: 'GPT-5.2 Codex',     ref: { provider: 'openai',    model: 'gpt-5.2-codex' } },
]

const ROLE_LABELS: Record<RalphRole, string> = {
  planner:   'Planner (writes architecture plan)',
  evaluator: 'Evaluator (critiques plan)',
  worker:    'Worker (implements backend/infra)',
  frontend:  'Frontend (implements UI)',
  reviewer:  'Reviewer (code review)',
}

export function formatConfigSummary(config: RalphConfig): string {
  const lines = (Object.entries(config) as [RalphRole, ModelRef][]).map(
    ([role, ref]) => {
      const label = AVAILABLE_MODELS.find(
        m => m.ref.provider === ref.provider && m.ref.model === ref.model
      )?.label ?? `${ref.provider}/${ref.model}`
      return `  ${ROLE_LABELS[role]}: ${label}`
    }
  )
  return lines.join('\n')
}

export function formatConfigPickerPrompt(config: RalphConfig): string {
  return `## /sebiralph Configuration

Current role assignments:
${formatConfigSummary(config)}

Available models:
${AVAILABLE_MODELS.map((m, i) => `  ${i + 1}. ${m.label} (${m.ref.provider})`).join('\n')}

Use these defaults? Reply with:
- **yes** to proceed
- **role=N** to change a role (e.g. "worker=1" to set Worker to Claude Opus 4.6)
- List multiple changes: "worker=4 frontend=5"`
}

export function applyConfigChanges(
  config: RalphConfig,
  changes: string,
): RalphConfig {
  const updated = { ...config }
  const pairs = changes.match(/(\w+)=(\d+)/g)
  if (!pairs) return updated

  const roles = Object.keys(ROLE_LABELS) as RalphRole[]
  for (const pair of pairs) {
    const [roleName, indexStr] = pair.split('=')
    const index = parseInt(indexStr!, 10) - 1
    const role = roles.find(r => r === roleName)
    if (role && index >= 0 && index < AVAILABLE_MODELS.length) {
      updated[role] = AVAILABLE_MODELS[index]!.ref
    }
  }
  return updated
}

export { AVAILABLE_MODELS, ROLE_LABELS }
```

- [ ] **Step 2: Commit**

```bash
git add source/src/skills/sebiralph/config.ts
git commit -m "feat(sebiralph): config picker with defaults and model selection"
```

---

### Task 6: PRD Types + Rendering

**Files:**
- Create: `source/src/skills/sebiralph/prd.ts`

- [ ] **Step 1: Create PRD module with JSON↔markdown**

```typescript
// source/src/skills/sebiralph/prd.ts
import type { RalphPlan, PRDTask, WaveDefinition } from './types.js'

export function renderPlanAsMarkdown(plan: RalphPlan): string {
  const lines: string[] = [
    `# ${plan.title}`,
    '',
    plan.summary,
    '',
    '## Shared Contracts',
    '',
  ]

  for (const [name, path] of Object.entries(plan.sharedContracts)) {
    lines.push(`- **${name}**: \`${path}\``)
  }

  for (const wave of plan.waves) {
    lines.push('', `## Wave ${wave.wave} (${wave.type})`, '')
    lines.push('| ID | Title | Role | Model | Owned Paths | Depends On | Acceptance |')
    lines.push('|----|-------|------|-------|-------------|------------|------------|')

    for (const taskId of wave.taskIds) {
      const task = plan.tasks.find(t => t.id === taskId)
      if (!task) continue
      const deps = task.dependsOn.length > 0 ? task.dependsOn.join(', ') : '-'
      const checks = task.acceptanceChecks.join('; ')
      const paths = task.ownedPaths.map(p => `\`${p}\``).join(', ')
      const model = `${task.modelRef.provider}/${task.modelRef.model}`
      lines.push(`| ${task.id} | ${task.title} | ${task.role} | ${model} | ${paths} | ${deps} | ${checks} |`)
    }
  }

  return lines.join('\n')
}

export function validatePlan(plan: RalphPlan): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  // Check all task IDs are unique
  const ids = plan.tasks.map(t => t.id)
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i)
  if (dupes.length > 0) errors.push(`Duplicate task IDs: ${dupes.join(', ')}`)

  // Check all dependsOn references exist
  for (const task of plan.tasks) {
    for (const dep of task.dependsOn) {
      if (!ids.includes(dep)) errors.push(`Task ${task.id} depends on unknown task ${dep}`)
    }
  }

  // Check no circular dependencies
  const visited = new Set<string>()
  const stack = new Set<string>()
  function hasCycle(id: string): boolean {
    if (stack.has(id)) return true
    if (visited.has(id)) return false
    visited.add(id)
    stack.add(id)
    const task = plan.tasks.find(t => t.id === id)
    if (task) {
      for (const dep of task.dependsOn) {
        if (hasCycle(dep)) return true
      }
    }
    stack.delete(id)
    return false
  }
  for (const task of plan.tasks) {
    if (hasCycle(task.id)) {
      errors.push(`Circular dependency detected involving task ${task.id}`)
      break
    }
  }

  // Check every task is in exactly one wave
  const waveTasks = plan.waves.flatMap(w => w.taskIds)
  for (const task of plan.tasks) {
    const count = waveTasks.filter(id => id === task.id).length
    if (count === 0) errors.push(`Task ${task.id} not assigned to any wave`)
    if (count > 1) errors.push(`Task ${task.id} assigned to multiple waves`)
  }

  // Check ownedPaths are disjoint within each wave
  for (const wave of plan.waves) {
    const pathOwners = new Map<string, string>()
    for (const taskId of wave.taskIds) {
      const task = plan.tasks.find(t => t.id === taskId)
      if (!task) continue
      for (const path of task.ownedPaths) {
        const existing = pathOwners.get(path)
        if (existing) {
          errors.push(`Wave ${wave.wave}: path \`${path}\` owned by both ${existing} and ${taskId}`)
        }
        pathOwners.set(path, taskId)
      }
    }
  }

  // Check every task has acceptance checks
  for (const task of plan.tasks) {
    if (task.acceptanceChecks.length === 0) {
      errors.push(`Task ${task.id} has no acceptance checks`)
    }
  }

  return { valid: errors.length === 0, errors }
}

export const PLAN_JSON_SCHEMA_PROMPT = `Output a JSON object matching this schema exactly:
{
  "title": "string — project title",
  "summary": "string — 2-3 sentence summary",
  "tasks": [
    {
      "id": "string — unique ID like t1, t2",
      "title": "string — short task title",
      "description": "string — what this task implements",
      "role": "worker | frontend",
      "modelRef": { "provider": "anthropic | openai", "model": "model-id" },
      "ownedPaths": ["paths this task writes to"],
      "dependsOn": ["task IDs that must complete first"],
      "inputs": ["paths this task reads"],
      "outputs": ["paths this task creates/modifies"],
      "acceptanceChecks": ["testable criteria"],
      "wave": 0,
      "status": "pending"
    }
  ],
  "waves": [
    { "wave": 0, "type": "contracts | implementation", "taskIds": ["t1"] }
  ],
  "sharedContracts": { "name": "path" }
}`
```

- [ ] **Step 2: Commit**

```bash
git add source/src/skills/sebiralph/prd.ts
git commit -m "feat(sebiralph): PRD types, JSON schema prompt, markdown renderer, validator"
```

---

### Task 7: Deterministic Gates

**Files:**
- Create: `source/src/skills/sebiralph/gates.ts`

- [ ] **Step 1: Create gates module**

```typescript
// source/src/skills/sebiralph/gates.ts
import { execSync } from 'node:child_process'
import type { GateResult } from './types.js'

function run(cmd: string, cwd: string): { ok: boolean; output: string } {
  try {
    const output = execSync(cmd, { cwd, encoding: 'utf-8', timeout: 120_000, stdio: ['pipe', 'pipe', 'pipe'] })
    return { ok: true, output: output.trim() }
  } catch (err: unknown) {
    const e = err as { stderr?: string; stdout?: string; message?: string }
    return { ok: false, output: (e.stderr || e.stdout || e.message || 'unknown error').trim() }
  }
}

export function runPathOwnershipGate(cwd: string, ownedPaths: string[]): GateResult {
  const { ok, output } = run('git diff --name-only HEAD', cwd)
  if (!ok) return { passed: false, gate: 'path-ownership', output: `git diff failed: ${output}` }

  const changedFiles = output.split('\n').filter(Boolean)
  const violations = changedFiles.filter(f => !ownedPaths.some(p => f.startsWith(p)))

  if (violations.length > 0) {
    return {
      passed: false,
      gate: 'path-ownership',
      output: `Modified files outside owned paths:\n${violations.join('\n')}`,
    }
  }
  return { passed: true, gate: 'path-ownership', output: `${changedFiles.length} files, all within owned paths` }
}

export function runBuildGate(cwd: string): GateResult {
  // Try common build commands in order
  const commands = [
    { test: 'package.json', cmd: 'npm run build --if-present' },
    { test: 'tsconfig.json', cmd: 'npx tsc --noEmit' },
    { test: 'Makefile', cmd: 'make build' },
  ]

  for (const { test, cmd } of commands) {
    const { ok: exists } = run(`test -f ${test} && echo yes`, cwd)
    if (exists) {
      const result = run(cmd, cwd)
      return { passed: result.ok, gate: 'build', output: result.output.slice(0, 2000) }
    }
  }
  return { passed: true, gate: 'build', output: 'No build system detected, skipping' }
}

export function runLintGate(cwd: string): GateResult {
  const commands = [
    { test: 'package.json', cmd: 'npm run lint --if-present' },
    { test: '.eslintrc', cmd: 'npx eslint .' },
    { test: 'pyproject.toml', cmd: 'ruff check .' },
  ]

  for (const { test, cmd } of commands) {
    const { ok: exists } = run(`test -f ${test} && echo yes`, cwd)
    if (exists) {
      const result = run(cmd, cwd)
      return { passed: result.ok, gate: 'lint', output: result.output.slice(0, 2000) }
    }
  }
  return { passed: true, gate: 'lint', output: 'No linter detected, skipping' }
}

export function runTestGate(cwd: string): GateResult {
  const commands = [
    { test: 'package.json', cmd: 'npm test --if-present' },
    { test: 'pytest.ini', cmd: 'pytest' },
    { test: 'pyproject.toml', cmd: 'pytest' },
  ]

  for (const { test, cmd } of commands) {
    const { ok: exists } = run(`test -f ${test} && echo yes`, cwd)
    if (exists) {
      const result = run(cmd, cwd)
      return { passed: result.ok, gate: 'test', output: result.output.slice(0, 2000) }
    }
  }
  return { passed: true, gate: 'test', output: 'No test runner detected, skipping' }
}

export function runAllGates(cwd: string, ownedPaths: string[]): GateResult[] {
  return [
    runPathOwnershipGate(cwd, ownedPaths),
    runBuildGate(cwd),
    runLintGate(cwd),
    runTestGate(cwd),
  ]
}
```

- [ ] **Step 2: Commit**

```bash
git add source/src/skills/sebiralph/gates.ts
git commit -m "feat(sebiralph): deterministic gates — path ownership, build, lint, test"
```

---

### Task 8: Integration Branch Management

**Files:**
- Create: `source/src/skills/sebiralph/integration.ts`

- [ ] **Step 1: Create integration branch module**

```typescript
// source/src/skills/sebiralph/integration.ts
import { execSync } from 'node:child_process'

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: 'utf-8', timeout: 30_000 }).trim()
}

export function createIntegrationBranch(sessionId: string, cwd: string): string {
  const branchName = `ralph/integration-${sessionId.slice(0, 8)}`
  const currentBranch = git('rev-parse --abbrev-ref HEAD', cwd)

  // Create integration branch from current HEAD
  git(`checkout -b ${branchName}`, cwd)
  // Go back to original branch
  git(`checkout ${currentBranch}`, cwd)

  return branchName
}

export function createWorktreeFromIntegration(
  integrationBranch: string,
  taskId: string,
  cwd: string,
): string {
  const worktreePath = `/tmp/ralph-worktree-${taskId}`
  const taskBranch = `ralph/task-${taskId}`

  // Create worktree with a new branch based on integration
  git(`worktree add -b ${taskBranch} ${worktreePath} ${integrationBranch}`, cwd)

  return worktreePath
}

export function mergeWorktreeToIntegration(
  worktreePath: string,
  integrationBranch: string,
  taskId: string,
  cwd: string,
): { success: boolean; output: string } {
  const taskBranch = `ralph/task-${taskId}`

  try {
    // Switch to integration branch
    git(`checkout ${integrationBranch}`, cwd)
    // Merge task branch
    const output = git(`merge --no-ff -m "ralph: merge task ${taskId}" ${taskBranch}`, cwd)
    return { success: true, output }
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string }
    return { success: false, output: e.stderr || e.message || 'merge failed' }
  }
}

export function cleanupWorktree(worktreePath: string, taskId: string, cwd: string): void {
  try {
    git(`worktree remove ${worktreePath} --force`, cwd)
    git(`branch -D ralph/task-${taskId}`, cwd)
  } catch {
    // best effort cleanup
  }
}

export function cleanupIntegrationBranch(sessionId: string, cwd: string): void {
  const branchName = `ralph/integration-${sessionId.slice(0, 8)}`
  try {
    git(`branch -D ${branchName}`, cwd)
  } catch {
    // best effort
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add source/src/skills/sebiralph/integration.ts
git commit -m "feat(sebiralph): integration branch + worktree management"
```

---

### Task 9: Planner (Phase 1)

**Files:**
- Create: `source/src/skills/sebiralph/planner.ts`

- [ ] **Step 1: Create planner module with planning loop prompt**

```typescript
// source/src/skills/sebiralph/planner.ts
import type { RalphConfig, RalphPlan } from './types.js'
import { PLAN_JSON_SCHEMA_PROMPT } from './prd.js'
import { formatConfigSummary } from './config.js'

export const HARD_GATES = [
  'Every task has ownedPaths (no unowned files)',
  'Dependencies are explicit and acyclic (no circular deps)',
  'Acceptance criteria are testable (build/test/lint can verify)',
  'Shared contract changes (types, API schema, DB) have a dedicated task in wave 0',
  'No more than 2 unresolved assumptions',
  'Wave assignment respects dependency order (dependsOn tasks are in earlier waves)',
]

export function buildPlannerPrompt(userTask: string, config: RalphConfig, codebaseContext: string): string {
  return `You are the Planner in a dual-model orchestration system. Your job is to create a detailed implementation plan for the following task.

## Task
${userTask}

## Codebase Context
${codebaseContext}

## Role Assignments
${formatConfigSummary(config)}

## Instructions
1. Analyze the task and codebase context
2. Break the work into discrete tasks with clear boundaries
3. Assign each task a role: "worker" (backend/infra) or "frontend" (UI)
4. Identify shared contracts (types, API schema, DB migrations) — these go in wave 0
5. Assign waves: wave 0 = contracts, wave 1+ = implementation (respecting dependencies)
6. For each task, define:
   - ownedPaths: exact file paths this task may modify (disjoint within each wave)
   - dependsOn: task IDs that must complete first
   - inputs/outputs: what this task reads/writes
   - acceptanceChecks: testable criteria (build passes, tests pass, specific behavior works)

## Output Format
${PLAN_JSON_SCHEMA_PROMPT}

Output ONLY the JSON object. No markdown fences, no explanation.`
}

export function buildEvaluatorPrompt(planJson: string, userTask: string): string {
  return `You are the Evaluator in a dual-model orchestration system. Review this plan against hard gates.

## Original Task
${userTask}

## Plan to Review
${planJson}

## Hard Gates — ALL must pass
${HARD_GATES.map((g, i) => `${i + 1}. ${g}`).join('\n')}

## Instructions
Check each gate. For each one, output PASS or FAIL with a brief reason.

If ALL gates pass, output:
VERDICT: APPROVED

If ANY gate fails, output:
VERDICT: REJECTED
FIXES NEEDED:
- [specific fix instruction for each failed gate]

Be strict but fair. Stylistic preferences don't fail gates.`
}

export function parseEvaluatorVerdict(response: string): {
  approved: boolean
  fixes: string[]
  rawResponse: string
} {
  const approved = response.includes('VERDICT: APPROVED')
  const fixes: string[] = []

  if (!approved) {
    const fixSection = response.split('FIXES NEEDED:')[1]
    if (fixSection) {
      const fixLines = fixSection.split('\n').filter(l => l.trim().startsWith('-'))
      fixes.push(...fixLines.map(l => l.trim().replace(/^-\s*/, '')))
    }
  }

  return { approved, fixes, rawResponse: response }
}

export function buildRevisionPrompt(
  originalPlan: string,
  evaluatorFeedback: string,
  iteration: number,
): string {
  return `You are the Planner. The Evaluator rejected your plan (iteration ${iteration}/3).

## Your Previous Plan
${originalPlan}

## Evaluator Feedback
${evaluatorFeedback}

## Instructions
Revise the plan to address ALL the evaluator's feedback. Keep changes minimal — only fix what was flagged.

Output ONLY the revised JSON plan. No markdown fences, no explanation.`
}
```

- [ ] **Step 2: Commit**

```bash
git add source/src/skills/sebiralph/planner.ts
git commit -m "feat(sebiralph): planner + evaluator prompts, hard gates, revision loop"
```

---

### Task 10: Swarm Dispatcher (Phase 3)

**Files:**
- Create: `source/src/skills/sebiralph/swarm.ts`

- [ ] **Step 1: Create swarm dispatcher**

```typescript
// source/src/skills/sebiralph/swarm.ts
import type { RalphPlan, PRDTask, RalphConfig, GateResult } from './types.js'

export type SwarmAgentSpec = {
  taskId: string
  prompt: string
  provider: 'anthropic' | 'openai'
  model: string
  worktreePath: string
  ownedPaths: string[]
  description: string
}

export function buildWorkerPrompt(task: PRDTask, plan: RalphPlan): string {
  const deps = task.dependsOn
    .map(id => plan.tasks.find(t => t.id === id))
    .filter(Boolean)
    .map(t => `- ${t!.id}: ${t!.title} (${t!.outputs.join(', ')})`)
    .join('\n')

  return `You are a worker agent implementing a specific task in a larger project.

## Your Task
**${task.title}** (ID: ${task.id})

${task.description}

## Constraints
- You may ONLY modify files in these paths: ${task.ownedPaths.map(p => `\`${p}\``).join(', ')}
- Do NOT modify any files outside your owned paths
- Do NOT create files outside your owned paths

## Inputs (files you can read)
${task.inputs.map(p => `- \`${p}\``).join('\n')}

## Expected Outputs
${task.outputs.map(p => `- \`${p}\``).join('\n')}

## Dependencies (already implemented)
${deps || '- None (this is a foundational task)'}

## Acceptance Criteria
${task.acceptanceChecks.map((c, i) => `${i + 1}. ${c}`).join('\n')}

## Instructions
1. Read the input files to understand the existing code and contracts
2. Implement the task according to the description
3. Ensure all acceptance criteria are met
4. Run any relevant tests to verify your work
5. Commit your changes with a descriptive message`
}

export function buildSwarmSpecs(
  plan: RalphPlan,
  wave: number,
  config: RalphConfig,
  worktreePaths: Map<string, string>,
): SwarmAgentSpec[] {
  const waveDef = plan.waves.find(w => w.wave === wave)
  if (!waveDef) return []

  return waveDef.taskIds.map(taskId => {
    const task = plan.tasks.find(t => t.id === taskId)!
    const modelRef = task.role === 'frontend' ? config.frontend : config.worker
    const worktreePath = worktreePaths.get(taskId)!

    return {
      taskId,
      prompt: buildWorkerPrompt(task, plan),
      provider: modelRef.provider,
      model: modelRef.model,
      worktreePath,
      ownedPaths: task.ownedPaths,
      description: `ralph-${task.role}: ${task.title}`,
    }
  })
}

export function formatWaveResults(
  wave: number,
  results: Map<string, { gates: GateResult[]; status: string }>,
): string {
  const lines = [`## Wave ${wave} Results\n`]
  for (const [taskId, result] of results) {
    const gateStatus = result.gates.every(g => g.passed) ? 'PASS' : 'FAIL'
    lines.push(`### ${taskId}: ${result.status} (gates: ${gateStatus})`)
    for (const gate of result.gates) {
      lines.push(`- ${gate.gate}: ${gate.passed ? 'PASS' : 'FAIL'} — ${gate.output.slice(0, 200)}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}
```

- [ ] **Step 2: Commit**

```bash
git add source/src/skills/sebiralph/swarm.ts
git commit -m "feat(sebiralph): swarm dispatcher — worker prompts, wave specs, result formatting"
```

---

### Task 11: Reviewer (Phase 4)

**Files:**
- Create: `source/src/skills/sebiralph/reviewer.ts`

- [ ] **Step 1: Create reviewer module**

```typescript
// source/src/skills/sebiralph/reviewer.ts
import type { PRDTask } from './types.js'

export function buildReviewPrompt(task: PRDTask, diffOutput: string): string {
  return `You are a code reviewer. Review this diff for task "${task.title}" (${task.id}).

## Task Description
${task.description}

## Acceptance Criteria
${task.acceptanceChecks.map((c, i) => `${i + 1}. ${c}`).join('\n')}

## Owned Paths (expected modifications)
${task.ownedPaths.map(p => `\`${p}\``).join(', ')}

## Diff
\`\`\`diff
${diffOutput}
\`\`\`

## Review Instructions
Focus ONLY on:
1. **Logic correctness** — Does the implementation match the acceptance criteria?
2. **Security** — Any injection, auth bypass, or data exposure issues?
3. **Acceptance criteria** — Is each criterion satisfied by the diff?

Do NOT flag:
- Style/formatting (handled by linter)
- Build/type errors (handled by automated gates)
- Missing tests (if not in acceptance criteria)

## Output Format
If everything looks good:
VERDICT: APPROVED

If issues found:
VERDICT: NEEDS_FIX
ISSUES:
- [issue description]
FIX_INSTRUCTIONS:
- [specific instruction for the worker to fix]`
}

export function parseReviewVerdict(response: string): {
  approved: boolean
  issues: string[]
  fixInstructions: string[]
} {
  const approved = response.includes('VERDICT: APPROVED')
  const issues: string[] = []
  const fixInstructions: string[] = []

  if (!approved) {
    const issueSection = response.split('ISSUES:')[1]?.split('FIX_INSTRUCTIONS:')[0]
    if (issueSection) {
      issues.push(...issueSection.split('\n').filter(l => l.trim().startsWith('-')).map(l => l.trim().replace(/^-\s*/, '')))
    }
    const fixSection = response.split('FIX_INSTRUCTIONS:')[1]
    if (fixSection) {
      fixInstructions.push(...fixSection.split('\n').filter(l => l.trim().startsWith('-')).map(l => l.trim().replace(/^-\s*/, '')))
    }
  }

  return { approved, issues, fixInstructions }
}

export function buildFixPrompt(task: PRDTask, reviewFeedback: string): string {
  return `The reviewer found issues with your implementation of "${task.title}".

## Review Feedback
${reviewFeedback}

## Your Owned Paths
${task.ownedPaths.map(p => `\`${p}\``).join(', ')}

## Instructions
Fix ONLY the issues identified by the reviewer. Do not make unrelated changes.
Stay within your owned paths. Commit the fix with a descriptive message.`
}
```

- [ ] **Step 2: Commit**

```bash
git add source/src/skills/sebiralph/reviewer.ts
git commit -m "feat(sebiralph): reviewer prompts, verdict parser, fix instructions"
```

---

### Task 12: Orchestrator

**Files:**
- Create: `source/src/skills/sebiralph/orchestrator.ts`

- [ ] **Step 1: Create the main orchestrator that coordinates all phases**

```typescript
// source/src/skills/sebiralph/orchestrator.ts
import type { RalphConfig, RalphPlan } from './types.js'
import { DEFAULT_CONFIG } from './types.js'
import { formatConfigPickerPrompt, formatConfigSummary } from './config.js'
import { renderPlanAsMarkdown, validatePlan, PLAN_JSON_SCHEMA_PROMPT } from './prd.js'
import { buildPlannerPrompt, buildEvaluatorPrompt, buildRevisionPrompt, parseEvaluatorVerdict } from './planner.js'
import { buildSwarmSpecs, formatWaveResults } from './swarm.js'
import { buildReviewPrompt, parseReviewVerdict, buildFixPrompt } from './reviewer.js'

const MAX_PLAN_ITERATIONS = 3
const MAX_FIX_RETRIES = 2

/**
 * Build the orchestrator prompt that the main agent will follow.
 * This is a meta-prompt: the main agent (running as the orchestrator)
 * uses AgentTool to spawn planner, evaluator, worker, and reviewer agents.
 */
export function buildOrchestratorPrompt(userTask: string, config: RalphConfig): string {
  return `# /sebiralph Orchestrator

You are the orchestrator for a dual-model implementation pipeline. You coordinate Claude and Codex agents to plan, implement, and review code.

## User's Task
${userTask}

## Configuration
${formatConfigSummary(config)}

## Your Workflow

### Phase 0: Codebase Context
First, use Glob and Read tools to understand the project structure. Gather:
- Main language/framework
- Directory structure
- Key files (package.json, tsconfig, etc.)
- Existing patterns

Store this context for the planner.

### Phase 1: Planning Loop (max ${MAX_PLAN_ITERATIONS} iterations)

1. **Spawn Planner agent** (provider: ${config.planner.provider}, model: ${config.planner.model}):
   - Use Agent tool with: provider="${config.planner.provider}", model (map to alias)
   - Task: analyze codebase and create implementation plan as JSON
   - The planner must output a JSON plan matching the PRDTask schema

2. **Parse the plan JSON** from the planner's response

3. **Spawn Evaluator agent** (provider: ${config.evaluator.provider}, model: ${config.evaluator.model}):
   - Use Agent tool with: provider="${config.evaluator.provider}"
   - Task: review the plan against hard gates
   - Hard gates:
     * Every task has ownedPaths
     * Dependencies are acyclic
     * Acceptance criteria are testable
     * Shared contracts have wave-0 owner
     * Max 2 unresolved assumptions
     * Waves respect dependency order

4. **If REJECTED**: spawn Planner again with evaluator's feedback (max ${MAX_PLAN_ITERATIONS} iterations)
   - If same critique repeats 2x, show user and ask for guidance
5. **If APPROVED**: proceed to Phase 2

### Phase 2: PRD Approval

1. Render the approved plan as a readable markdown table
2. Show to user with all tasks, waves, file ownership, acceptance criteria
3. Ask: "Approve this plan? [Y/n/edit]"
4. Wait for user approval before proceeding

### Phase 3: Swarm Implementation

For each wave (starting from wave 0):

1. **Create integration branch** if not exists (use Bash: \`git checkout -b ralph/integration-...\`)
2. **For each task in the wave**, spawn a worker agent:
   - Use Agent tool with:
     - provider: task's provider ("${config.worker.provider}" for workers, "${config.frontend.provider}" for frontend)
     - isolation: "worktree"
     - run_in_background: true (for parallel execution)
   - Prompt: task description + owned paths + acceptance criteria + constraints
3. **Wait for all agents in the wave to complete**
4. **Run deterministic gates** on each worktree (use Bash):
   - \`git diff --name-only HEAD\` to check path ownership
   - Build/lint/test commands
5. **If gates fail**: send fix instructions back to the worker (max ${MAX_FIX_RETRIES} retries)

### Phase 4: Review & Merge

For each completed task (gates passed):

1. **Get the diff** (use Bash: \`git diff main...HEAD\` in the worktree)
2. **Spawn Reviewer agent** (provider: ${config.reviewer.provider}, model: ${config.reviewer.model}):
   - Task: review the diff against acceptance criteria
3. **If NEEDS_FIX**: send fix instructions to original worker, re-gate, re-review (max ${MAX_FIX_RETRIES} cycles)
4. **If APPROVED**: merge worktree to integration branch
5. **After all tasks in wave merged**: run integration test
6. **Proceed to next wave**

### Phase 5: Summary

After all waves complete:
1. Show summary: tasks completed, tasks failed, files changed
2. The integration branch has all changes ready

## Important Rules
- ALWAYS use the \`provider\` field when spawning agents to ensure correct model routing
- Worker agents get isolation: "worktree" for parallel execution
- NEVER let workers modify files outside their ownedPaths
- Run deterministic gates BEFORE review to save reviewer time
- If anything fails after max retries, escalate to the user — don't loop forever`
}
```

- [ ] **Step 2: Commit**

```bash
git add source/src/skills/sebiralph/orchestrator.ts
git commit -m "feat(sebiralph): main orchestrator — 5-phase meta-prompt for dual-model pipeline"
```

---

### Task 13: Skill Registration

**Files:**
- Create: `source/src/skills/sebiralph/index.ts`
- Modify: `source/src/skills/bundledSkills.ts`

- [ ] **Step 1: Create skill entry point**

```typescript
// source/src/skills/sebiralph/index.ts
import { registerBundledSkill } from '../bundledSkills.js'
import { DEFAULT_CONFIG } from './types.js'
import { formatConfigPickerPrompt } from './config.js'
import { buildOrchestratorPrompt } from './orchestrator.js'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.js'

export function registerSebiRalphSkill(): void {
  registerBundledSkill({
    name: 'sebiralph',
    description: 'Dual-model orchestration: Claude plans + reviews, Codex implements. Parallel swarm with wave-based execution.',
    aliases: ['ralph'],
    whenToUse: 'When the user wants to orchestrate a complex implementation using both Claude and Codex models collaboratively',
    userInvocable: true,
    allowedTools: ['Agent', 'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
    model: 'opus',
    context: 'fork',
    agent: 'general-purpose',
    argumentHint: '<task description>',

    async getPromptForCommand(args: string): Promise<ContentBlockParam[]> {
      const config = DEFAULT_CONFIG
      const configPrompt = formatConfigPickerPrompt(config)
      const orchestratorPrompt = buildOrchestratorPrompt(args, config)

      return [
        {
          type: 'text',
          text: `${configPrompt}\n\n---\n\nAssuming defaults are accepted, here is your orchestration plan:\n\n${orchestratorPrompt}`,
        },
      ]
    },
  })
}
```

- [ ] **Step 2: Register in bundledSkills.ts**

Find the imports section in `source/src/skills/bundledSkills.ts` and add:

```typescript
import { registerSebiRalphSkill } from './sebiralph/index.js'
```

Find where other skills are registered (look for calls to `registerBundledSkill` or a registration function) and add:

```typescript
registerSebiRalphSkill()
```

- [ ] **Step 3: Build**

```bash
cd /home/dkmserver/Desktop/Machinity/aytug/sebi-code
export PATH="$HOME/.bun/bin:$PATH"
rm -f .cache/workspace/.prepared.json
node scripts/build-cli.mjs --no-minify
```

Expected: Build succeeds.

- [ ] **Step 4: Verify skill is registered**

```bash
node dist/cli.js --help 2>&1 | grep -i ralph
# Or test directly:
CLAUDE_CODE_USE_CODEX=1 node dist/cli.js -p "/sebiralph test" --dangerously-skip-permissions 2>&1 | head -20
```

- [ ] **Step 5: Commit**

```bash
git add source/src/skills/sebiralph/ source/src/skills/bundledSkills.ts
git commit -m "feat(sebiralph): register /sebiralph skill — dual-model orchestration ready"
```

---

### Task 14: End-to-End Test

**Files:** None (testing only)

- [ ] **Step 1: Test Anthropic mode still works**

```bash
cd /home/dkmserver/Desktop/Machinity/aytug/sebi-code
node dist/cli.js -p "Say hello" 2>&1
```

Expected: Claude responds normally.

- [ ] **Step 2: Test Codex mode still works**

```bash
CLAUDE_CODE_USE_CODEX=1 node dist/cli.js -p "Say hello" 2>&1
```

Expected: Codex responds normally.

- [ ] **Step 3: Test /sebiralph invocation**

```bash
CLAUDE_CODE_USE_CODEX=1 node dist/cli.js -p "/sebiralph Create a simple HTTP server with health check endpoint" --allowedTools "Agent Bash Read Write Edit Glob Grep" --dangerously-skip-permissions 2>&1 | head -50
```

Expected: Orchestrator shows config, begins planning flow.

- [ ] **Step 4: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix(sebiralph): end-to-end test fixes"
```
