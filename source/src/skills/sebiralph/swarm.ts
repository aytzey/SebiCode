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

  return `You are a worker agent implementing a specific task.

## Task: ${task.title} (${task.id})
${task.description}

## Constraints
- ONLY modify: ${task.ownedPaths.map(p => `\`${p}\``).join(', ')}
- Do NOT modify files outside owned paths

## Inputs: ${task.inputs.map(p => `\`${p}\``).join(', ')}
## Expected Outputs: ${task.outputs.map(p => `\`${p}\``).join(', ')}
## Dependencies: ${deps || 'None'}
## Acceptance Criteria
${task.acceptanceChecks.map((c, i) => `${i + 1}. ${c}`).join('\n')}

Implement, test, commit.`
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
