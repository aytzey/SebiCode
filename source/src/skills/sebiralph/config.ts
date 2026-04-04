import type { RalphConfig, RalphRole, ModelRef, RalphWorkflowDefaults } from './types.js'

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

export function formatWorkflowSummary(workflow: RalphWorkflowDefaults): string {
  return [
    `  TDD: ${workflow.tdd ? 'ON (default)' : 'OFF'}`,
    `  Deploy verification: ${workflow.deployVerification ? 'REQUIRED when TDD is ON' : 'OPTIONAL'}`,
    `  Gate fix retries: ${workflow.maxGateFixAttempts}`,
    `  Review fix cycles: ${workflow.maxReviewFixCycles}`,
    `  Deploy fix cycles: ${workflow.maxDeployFixCycles}`,
  ].join('\n')
}

export function formatConfigPickerPrompt(config: RalphConfig): string {
  return `## /sebiralph Configuration

Current role assignments:
${formatConfigSummary(config)}

Available models:
${AVAILABLE_MODELS.map((m, i) => `  ${i + 1}. ${m.label} (${m.ref.provider})`).join('\n')}

Use these defaults? Reply with:
- **yes** to proceed
- **role=N** to change a role (e.g. "worker=4" to set Worker to GPT-5.4)
- List multiple changes: "worker=4 frontend=2"`
}

export function applyConfigChanges(config: RalphConfig, changes: string): RalphConfig {
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
