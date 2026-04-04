import type { RalphPlan, PRDTask } from './types.js'

const TEST_ACCEPTANCE_PATTERN = /\b(test|tests|spec|specs|regression|smoke|e2e|integration)\b/i

export function hasExplicitTestAcceptanceCheck(task: PRDTask): boolean {
  return task.acceptanceChecks.some(check => TEST_ACCEPTANCE_PATTERN.test(check))
}

export function renderPlanAsMarkdown(plan: RalphPlan): string {
  const lines: string[] = [`# ${plan.title}`, '', plan.summary, '', '## Shared Contracts', '']
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
  const ids = plan.tasks.map(t => t.id)
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i)
  if (dupes.length > 0) errors.push(`Duplicate task IDs: ${dupes.join(', ')}`)
  for (const task of plan.tasks) {
    for (const dep of task.dependsOn) {
      if (!ids.includes(dep)) errors.push(`Task ${task.id} depends on unknown task ${dep}`)
    }
  }
  const visited = new Set<string>()
  const stack = new Set<string>()
  function hasCycle(id: string): boolean {
    if (stack.has(id)) return true
    if (visited.has(id)) return false
    visited.add(id)
    stack.add(id)
    const task = plan.tasks.find(t => t.id === id)
    if (task) { for (const dep of task.dependsOn) { if (hasCycle(dep)) return true } }
    stack.delete(id)
    return false
  }
  for (const task of plan.tasks) {
    if (hasCycle(task.id)) { errors.push(`Circular dependency detected involving task ${task.id}`); break }
  }
  const waveTasks = plan.waves.flatMap(w => w.taskIds)
  for (const task of plan.tasks) {
    const count = waveTasks.filter(id => id === task.id).length
    if (count === 0) errors.push(`Task ${task.id} not assigned to any wave`)
    if (count > 1) errors.push(`Task ${task.id} assigned to multiple waves`)
  }
  for (const wave of plan.waves) {
    const pathOwners: Array<{ path: string; taskId: string }> = []
    for (const taskId of wave.taskIds) {
      const task = plan.tasks.find(t => t.id === taskId)
      if (!task) continue
      for (const path of task.ownedPaths) {
        // Check exact match and prefix overlaps (e.g. "src/" and "src/api/")
        for (const existing of pathOwners) {
          if (existing.path === path || path.startsWith(existing.path) || existing.path.startsWith(path)) {
            errors.push(`Wave ${wave.wave}: path \`${path}\` (${taskId}) overlaps with \`${existing.path}\` (${existing.taskId})`)
          }
        }
        pathOwners.push({ path, taskId })
      }
    }
  }
  for (const task of plan.tasks) {
    if (task.acceptanceChecks.length === 0) errors.push(`Task ${task.id} has no acceptance checks`)
    if (!hasExplicitTestAcceptanceCheck(task)) {
      errors.push(`Task ${task.id} must include at least one explicit test/regression acceptance check for TDD`)
    }
  }
  return { valid: errors.length === 0, errors }
}

export const PLAN_JSON_SCHEMA_PROMPT = `Output a JSON object matching this schema exactly:
{
  "title": "string",
  "summary": "string",
  "tasks": [{
    "id": "string (t1, t2...)", "title": "string", "description": "string",
    "role": "worker | frontend",
    "modelRef": { "provider": "anthropic | openai", "model": "model-id" },
    "ownedPaths": ["paths"], "dependsOn": ["task IDs"],
    "inputs": ["paths"], "outputs": ["paths"],
    "acceptanceChecks": ["testable criteria"],
    "wave": 0, "status": "pending"
  }],
  "waves": [{ "wave": 0, "type": "contracts | implementation", "taskIds": ["t1"] }],
  "sharedContracts": { "name": "path" }
}`
