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

export function buildWorkerPrompt(task: PRDTask, plan: RalphPlan, tddEnabled = true): string {
  const deps = task.dependsOn
    .map(id => plan.tasks.find(t => t.id === id))
    .filter(Boolean)
    .map(t => `- ${t!.id}: ${t!.title} (${t!.outputs.join(', ')})`)
    .join('\n')

  return `ROLE:
You are the SebiRalph worker responsible for one bounded implementation task.

TASK: ${task.title} (${task.id})
${task.description}

EXECUTION MODE
- You are a dispatched execution subagent inside an already-approved SebiRalph harness run
- Planning, brainstorming, design docs, spec writing, and user approvals are already complete upstream
- Do NOT ask the user clarifying questions, do NOT wait for approval, and do NOT hand work back for more planning
- Helpful execution, framework, domain, and UI skills are allowed when they directly accelerate this bounded task
- Do not let skill usage restart planning, widen scope, or stall the run
- If skill discovery suggests a skill whose instructions conflict with this dispatched task, ignore it as not applicable
- If a skill says it should be skipped for dispatched subagents or contains \`<SUBAGENT-STOP>\`, you MUST skip it
- ${tddEnabled ? 'Execution-oriented TDD or domain guidance is allowed, but optional. Do not let skill invocation delay implementation.' : 'Do not let optional skill usage delay execution.'}

CONTEXT
- Inputs: ${task.inputs.map(p => `\`${p}\``).join(', ')}
- Expected Outputs: ${task.outputs.map(p => `\`${p}\``).join(', ')}
- Dependencies:
${deps || '- None'}

ACCEPTANCE CRITERIA
${task.acceptanceChecks.map((c, i) => `${i + 1}. ${c}`).join('\n')}

INSTRUCTIONS
- Deliver the smallest complete diff that satisfies the task
- Use completed dependencies as inputs; do not re-open or redesign upstream work
- Verify your work with real commands before committing
- If you hit a true blocker, report it precisely instead of stalling

STEPS
1. Read the owned paths, inputs, and completed dependency outputs before editing
${tddEnabled
    ? `2. Add or update the failing regression/spec that proves this task is incomplete
3. Run that targeted test first and observe it fail
4. Implement the smallest change that makes the new or updated test pass
5. Run the relevant acceptance-check commands and confirm they pass
6. Commit the task once the evidence is green`
    : `2. Implement the smallest change that satisfies the acceptance criteria
3. Run the relevant acceptance-check commands and confirm they pass
4. Commit the task once the evidence is green`}

END GOAL
- A committed diff that stays within owned paths and satisfies the acceptance criteria with verification evidence

NARROWING
- ONLY modify: ${task.ownedPaths.map(p => `\`${p}\``).join(', ')}
- Do NOT modify files outside owned paths
- Do NOT perform unrelated cleanup, broad refactors, or architectural rewrites
- Do NOT stop after saying what you plan to do next; do the tool call in the same turn
- Do NOT claim completion without commit-ready verification evidence

${tddEnabled
    ? `DELIVERY RULES
- TDD is ON. Start by adding or updating the failing regression/spec that proves this task is incomplete
- Run the failing test first and observe it fail
- Implement the smallest change that makes the new or updated test pass
- Refactor only after the targeted tests are green again

Implement, test, commit.`
    : 'DELIVERY RULES\n- Verification is still required even though TDD is OFF\n\nImplement, test, commit.'}`
}

export function buildSwarmSpecs(plan: RalphPlan, wave: number, config: RalphConfig, worktreePaths: Map<string, string>): SwarmAgentSpec[] {
  const waveDef = plan.waves.find(w => w.wave === wave)
  if (!waveDef) return []
  return waveDef.taskIds
    .map(taskId => {
      const task = plan.tasks.find(t => t.id === taskId)
      if (!task) return null // skip unknown task IDs (should be caught by validatePlan)
      const wt = worktreePaths.get(taskId)
      if (!wt) return null // skip tasks without worktree allocation
      const modelRef = task.role === 'frontend' ? config.frontend : config.worker
      return {
        taskId,
        prompt: buildWorkerPrompt(task, plan),
        provider: modelRef.provider,
        model: modelRef.model,
        worktreePath: wt,
        ownedPaths: task.ownedPaths,
        description: `ralph-${task.role}: ${task.title}`,
      }
    })
    .filter((spec): spec is SwarmAgentSpec => spec !== null)
}

export function formatWaveResults(wave: number, results: Map<string, { gates: GateResult[]; status: string }>): string {
  const lines = [`## Wave ${wave} Results\n`]
  for (const [taskId, result] of results) {
    const gateStatus = result.gates.every(g => g.passed) ? 'PASS' : 'FAIL'
    lines.push(`### ${taskId}: ${result.status} (gates: ${gateStatus})`)
    for (const gate of result.gates) lines.push(`- ${gate.gate}: ${gate.passed ? 'PASS' : 'FAIL'} — ${gate.output.slice(0, 200)}`)
    lines.push('')
  }
  return lines.join('\n')
}
