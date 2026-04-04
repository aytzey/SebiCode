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

export type RalphWorkflowDefaults = {
  tdd: boolean
  deployVerification: boolean
  maxPlanIterations: number
  maxGateFixAttempts: number
  maxReviewFixCycles: number
  maxDeployFixCycles: number
}

export const DEFAULT_WORKFLOW: RalphWorkflowDefaults = {
  tdd: true,
  deployVerification: true,
  maxPlanIterations: 3,
  maxGateFixAttempts: 2,
  maxReviewFixCycles: 2,
  maxDeployFixCycles: 3,
}

export type RalphRuntimeContext = {
  runId: string
  sessionId?: string
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
  fixInstructions: string[]
}
