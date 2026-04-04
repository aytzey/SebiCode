import type {
  RalphConfig,
  RalphWorkflowDefaults,
} from '../../skills/sebiralph/types.js'

export type SebiRalphPhase =
  | 'config_review'
  | 'explore'
  | 'plan'
  | 'evaluate'
  | 'prd_approval'
  | 'wave_execution'
  | 'gate_validation'
  | 'review_fix'
  | 'integration_merge'
  | 'deploy_verify'
  | 'completed'
  | 'blocked'

export type SebiRalphRunStatus =
  | 'active'
  | 'awaiting_user'
  | 'completed'
  | 'blocked'

export type SebiRalphTaskRecord = {
  id: string
  title: string
  wave: number
  status:
    | 'pending'
    | 'in_progress'
    | 'gated'
    | 'review'
    | 'merged'
    | 'failed'
    | 'unknown'
  ownedPaths: string[]
  acceptanceChecks: string[]
}

export type SebiRalphWaveRecord = {
  wave: number
  taskIds: string[]
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'unknown'
}

export type SebiRalphDeployRecord = {
  status: 'unknown' | 'pending' | 'passed' | 'failed' | 'blocked'
  target?: string
  url?: string
  verifyCommand?: string
  runtimeSurface?: string
  fixCycles: number
  lastEvidence?: string
  updatedAt?: string
}

export type SebiRalphExecutionPolicy = {
  fullAuto: boolean
  tdd: boolean
  deployVerification: boolean
  optionalRemotePush: boolean
  maxPlanIterations: number
  maxGateFixAttempts: number
  maxReviewFixCycles: number
  maxDeployFixCycles: number
}

export type SebiRalphRunState = {
  id: string
  sessionId: string
  projectPath: string
  userTask: string
  createdAt: string
  updatedAt: string
  config: RalphConfig
  workflow: RalphWorkflowDefaults
  executionPolicy: SebiRalphExecutionPolicy
  phase: SebiRalphPhase
  status: SebiRalphRunStatus
  planJson?: string
  integrationBranch?: string
  taskRecords: SebiRalphTaskRecord[]
  waveRecords: SebiRalphWaveRecord[]
  deploy: SebiRalphDeployRecord
  lastProgressMarker?: string
  completedAt?: string
}

export type SebiRalphRunLookup = {
  run: SebiRalphRunState
  transcriptFound: boolean
}
