import type { RalphConfig, RalphRole, ModelRef } from './types.js'
import { formatConfigSummary } from './config.js'
import { PLAN_JSON_SCHEMA_PROMPT } from './prd.js'
import { HARD_GATES } from './planner.js'

export function buildOrchestratorPrompt(userTask: string, config: RalphConfig): string {
  // Build provider/model info per role for agent dispatch
  const agentInfo = (role: RalphRole): string => {
    const ref = config[role]
    return `provider: "${ref.provider}" (${ref.model})`
  }

  return `You are the /sebiralph orchestrator. You coordinate multiple AI agents (Claude + Codex) to implement the user's task.

## Task
${userTask}

## Roles
- Planner: ${agentInfo('planner')}
- Evaluator: ${agentInfo('evaluator')}
- Worker: ${agentInfo('worker')}
- Frontend: ${agentInfo('frontend')}
- Reviewer: ${agentInfo('reviewer')}

## Execute this workflow step by step:

### Step 1: Explore Codebase
Use Glob and Read to understand the project. Note: language, framework, directory structure, key files.

### Step 2: Plan
Spawn a Planner agent:
\`\`\`
Agent tool call:
  description: "Plan implementation"
  prompt: [user task + codebase context + JSON schema instructions]
  provider: "${config.planner.provider}"
\`\`\`
The planner must output a JSON plan with tasks, waves, ownedPaths, dependsOn, acceptanceChecks.

${PLAN_JSON_SCHEMA_PROMPT}

### Step 3: Evaluate Plan
Spawn an Evaluator agent with the plan JSON:
\`\`\`
Agent tool call:
  description: "Evaluate plan"
  prompt: [plan JSON + hard gates]
  provider: "${config.evaluator.provider}"
\`\`\`
Hard gates: ${HARD_GATES.join('; ')}

If REJECTED: revise plan (max 3 iterations). If APPROVED: continue.

### Step 4: Show PRD to User
Render the plan as a markdown table showing tasks, waves, ownership, criteria.
Ask: "Approve this plan? [Y/n]"
STOP and wait for user approval.

### Step 5: Implement (Parallel Swarm)
For each wave (0, 1, 2...):

a) Create integration branch: \`git checkout -b ralph/integration\`

b) For each task in the wave, spawn a worker agent:
\`\`\`
Agent tool call:
  description: "Implement [task title]"
  prompt: [task description + owned paths + acceptance criteria]
  provider: "[worker or frontend provider]"
  isolation: "worktree"
  run_in_background: true
\`\`\`
- Worker tasks → provider: "${config.worker.provider}"
- Frontend tasks → provider: "${config.frontend.provider}"

c) Wait for all agents in wave to complete.

d) Run gates per worktree (use Bash):
- \`git diff --name-only HEAD\` — check only owned paths modified
- Run build/test if available

e) If gates fail: send fix instructions to worker (max 2 retries)

### Step 6: Review & Merge
For each task that passed gates:

a) Get diff: \`git diff main...HEAD\` in worktree

b) Spawn Reviewer agent:
\`\`\`
Agent tool call:
  description: "Review [task title]"
  prompt: [diff + acceptance criteria]
  provider: "${config.reviewer.provider}"
\`\`\`

c) If NEEDS_FIX: worker fixes → re-gate → re-review (max 2 cycles)
d) If APPROVED: merge to integration branch

### Step 7: Summary
Show: tasks completed, files changed, integration branch name.

## CRITICAL RULES
- ALWAYS include \`provider\` field when spawning agents — this routes to the correct AI model
- Workers get \`isolation: "worktree"\` for parallel execution
- Never let workers modify files outside their ownedPaths
- If anything fails after retries, show the error to the user — don't loop forever
- Start with Step 1 NOW.`
}

export { formatConfigSummary }
