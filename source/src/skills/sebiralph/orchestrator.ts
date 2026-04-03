import type { RalphConfig, RalphRole } from './types.js'
import { formatConfigSummary } from './config.js'

export function buildOrchestratorPrompt(userTask: string, config: RalphConfig): string {
  const ref = (role: RalphRole) => `${config[role].provider}/${config[role].model}`

  return `You are /sebiralph orchestrator. Coordinate AI agents to implement this task:

${userTask}

## Agent Providers
Planner=${ref('planner')} | Evaluator=${ref('evaluator')} | Worker=${ref('worker')} | Frontend=${ref('frontend')} | Reviewer=${ref('reviewer')}

## Steps (execute in order)

1. **Explore** — Glob/Read the project structure. Note language, framework, key files.

2. **Plan** — Spawn Planner agent (provider: "${config.planner.provider}"). Provide task + codebase context. Planner outputs JSON plan with tasks, waves, ownedPaths, dependsOn, acceptanceChecks.

3. **Evaluate** — Spawn Evaluator (provider: "${config.evaluator.provider}") with plan JSON. Gates: owned paths required, acyclic deps, testable acceptance criteria, contracts in wave 0. If rejected, revise (max 3 tries).

4. **Show PRD** — Render plan as markdown table. Ask user: "Approve? [Y/n]". STOP and wait.

5. **Implement** — Per wave: create integration branch, spawn workers in parallel (isolation: "worktree", run_in_background: true). Worker tasks use provider "${config.worker.provider}", frontend tasks use "${config.frontend.provider}". After wave completes: verify only ownedPaths changed, run build/test. Retry failures max 2x.

6. **Review** — Per completed task: get diff, spawn Reviewer (provider: "${config.reviewer.provider}"). If NEEDS_FIX: worker fixes, re-review (max 2 cycles). If APPROVED: merge to integration.

7. **Summary** — Report tasks completed, files changed, branch name.

## Rules
- ALWAYS set \`provider\` field on Agent calls — it routes to the correct model
- Workers MUST get \`isolation: "worktree"\`
- Workers must not touch files outside ownedPaths
- On unrecoverable failure, report error to user — never loop forever

Start with Step 1 now.`
}

export { formatConfigSummary }
