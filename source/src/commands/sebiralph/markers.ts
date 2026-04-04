import type {
  SebiRalphDeployRecord,
  SebiRalphPhase,
  SebiRalphQualityVerdict,
  SebiRalphRunStatus,
} from './types.js'

export type SebiRalphTranscriptMessage = {
  text: string
  isApiError?: boolean
}

export type SebiRalphTranscriptHydration = {
  updatedAt: string
  phase?: SebiRalphPhase
  status?: SebiRalphRunStatus
  lastProgressMarker?: string
  completedAt?: string
  integrationBranch?: string
  lastError?: string | null
  deploy?: Partial<SebiRalphDeployRecord>
  qualityLoopsCompleted?: number
  lastQualityVerdict?: SebiRalphQualityVerdict
}

type ScopedEvent<T> = T & {
  order: number
  raw: string
}

type ProgressEvent = ScopedEvent<{
  phase: SebiRalphPhase
  status: SebiRalphRunStatus
}>

type IntegrationEvent = ScopedEvent<{
  branch: string
}>

type DeployEvent = ScopedEvent<{
  status: SebiRalphDeployRecord['status']
  target?: string
  url?: string
}>

type LoopEvent = ScopedEvent<{
  iteration: number
  verdict: SebiRalphQualityVerdict
}>

type ApiErrorEvent = {
  order: number
  text: string
}

const MARKER_RE = /<(sebiralph-[a-z]+)\b[^>]*\/?>/gi
const MARKER_ATTR_RE = /([a-z_]+)="([^"]*)"/gi

function parsePhase(raw: string | undefined): SebiRalphPhase | null {
  switch (raw) {
    case 'config_review':
    case 'explore':
    case 'plan':
    case 'evaluate':
    case 'prd_approval':
    case 'wave_execution':
    case 'gate_validation':
    case 'review_fix':
    case 'integration_merge':
    case 'deploy_verify':
    case 'completed':
    case 'blocked':
      return raw
    default:
      return null
  }
}

function parseProgressStatus(raw: string | undefined): SebiRalphRunStatus | null {
  switch (raw) {
    case 'entered':
    case 'completed':
      return 'active'
    case 'awaiting_user':
      return 'awaiting_user'
    case 'blocked':
      return 'blocked'
    default:
      return null
  }
}

function parseDeployStatus(
  raw: string | undefined,
): SebiRalphDeployRecord['status'] | null {
  switch (raw?.toLowerCase()) {
    case 'pending':
    case 'passed':
    case 'failed':
    case 'blocked':
      return raw.toLowerCase() as SebiRalphDeployRecord['status']
    case 'pass':
      return 'passed'
    case 'fail':
      return 'failed'
    default:
      return null
  }
}

function parseMarkerAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  MARKER_ATTR_RE.lastIndex = 0
  for (const match of raw.matchAll(MARKER_ATTR_RE)) {
    const key = match[1]
    const value = match[2]
    if (!key || value === undefined) continue
    attrs[key] = value
  }
  return attrs
}

function parseLoopVerdict(raw: string | undefined): SebiRalphQualityVerdict | null {
  switch (raw?.toLowerCase()) {
    case 'refine':
      return 'refine'
    case 'ship_it':
    case 'shipit':
      return 'ship_it'
    case 'limit_reached':
    case 'limit':
      return 'limit_reached'
    default:
      return null
  }
}

function getScopedMarkers(
  runId: string,
  messages: SebiRalphTranscriptMessage[],
): {
  progress: ProgressEvent | null
  integration: IntegrationEvent | null
  deploy: DeployEvent | null
  loop: LoopEvent | null
  apiError: ApiErrorEvent | null
  seenRunIds: Set<string>
  assistantText: string
} {
  let progress: ProgressEvent | null = null
  let integration: IntegrationEvent | null = null
  let deploy: DeployEvent | null = null
  let loop: LoopEvent | null = null
  let apiError: ApiErrorEvent | null = null
  const seenRunIds = new Set<string>()
  const assistantTextParts: string[] = []

  for (const [messageIndex, message] of messages.entries()) {
    const text = message.text.trim()
    if (!text) continue

    assistantTextParts.push(text)

    const baseOrder = messageIndex * 1000
    if (message.isApiError) {
      apiError = {
        text,
        order: baseOrder,
      }
    }

    let markerOffset = 0
    MARKER_RE.lastIndex = 0
    for (const match of text.matchAll(MARKER_RE)) {
      const raw = match[0]
      const name = match[1]
      if (!raw || !name) continue

      markerOffset += 1
      const order = baseOrder + markerOffset
      const attrs = parseMarkerAttrs(raw)
      const markerRunId = attrs.run_id
      if (markerRunId) {
        seenRunIds.add(markerRunId)
      }
      if (markerRunId !== runId) {
        continue
      }

      if (name === 'sebiralph-progress') {
        const phase = parsePhase(attrs.phase)
        const status = parseProgressStatus(attrs.status)
        if (!phase || !status) continue
        progress = {
          phase,
          status,
          raw,
          order,
        }
        continue
      }

      if (name === 'sebiralph-integration') {
        const branch = attrs.branch?.trim()
        if (!branch) continue
        integration = {
          branch,
          raw,
          order,
        }
        continue
      }

      if (name === 'sebiralph-deploy') {
        const status = parseDeployStatus(attrs.status)
        if (!status) continue
        deploy = {
          status,
          target: attrs.target || undefined,
          url: attrs.url || undefined,
          raw,
          order,
        }
        continue
      }

      if (name === 'sebiralph-loop') {
        const verdict = parseLoopVerdict(attrs.verdict)
        const iteration = Number.parseInt(attrs.iteration ?? '', 10)
        if (!verdict || !Number.isFinite(iteration) || iteration < 1) continue
        loop = {
          iteration,
          verdict,
          raw,
          order,
        }
      }
    }
  }

  return {
    progress,
    integration,
    deploy,
    loop,
    apiError,
    seenRunIds,
    assistantText: assistantTextParts.join('\n\n'),
  }
}

export function deriveRunHydrationFromTranscript(params: {
  runId: string
  messages: SebiRalphTranscriptMessage[]
  modifiedAt: string
}): SebiRalphTranscriptHydration {
  const { runId, messages, modifiedAt } = params
  const next: SebiRalphTranscriptHydration = {
    updatedAt: modifiedAt,
  }
  const {
    progress,
    integration,
    deploy,
    loop,
    apiError,
    seenRunIds,
    assistantText,
  } =
    getScopedMarkers(runId, messages)

  if (progress) {
    next.phase = progress.phase
    next.status = progress.status
    next.lastProgressMarker = progress.raw
    if (progress.phase === 'completed') {
      next.phase = 'completed'
      next.status = 'completed'
      next.completedAt = modifiedAt
      next.lastError = null
    }
  }

  if (integration) {
    next.integrationBranch = integration.branch
  }

  if (deploy) {
    next.deploy = {
      status: deploy.status,
      target: deploy.target,
      url: deploy.url,
      updatedAt: modifiedAt,
    }
    if (deploy.status === 'passed') {
      next.lastError = null
    }
  }

  if (loop) {
    next.qualityLoopsCompleted = loop.iteration
    next.lastQualityVerdict = loop.verdict
  }

  const allowLegacySummaryFallback = seenRunIds.size <= 1
  if (allowLegacySummaryFallback) {
    if (/SebiRalph complete\./i.test(assistantText)) {
      next.phase = 'completed'
      next.status = 'completed'
      next.completedAt = modifiedAt
      next.lastError = null
    }

    if (!next.integrationBranch) {
      const integrationBranchMatch = assistantText.match(
        /Integration branch:\s*`([^`]+)`/i,
      )
      if (integrationBranchMatch?.[1]) {
        next.integrationBranch = integrationBranchMatch[1]
      }
    }

    if (!next.deploy?.status) {
      const deployVerdict = assistantText.match(
        /Deploy verification:\s*(PASS|FAIL|BLOCKED)/i,
      )
      if (deployVerdict?.[1]) {
        const status = parseDeployStatus(deployVerdict[1])
        if (status) {
          next.deploy = {
            ...(next.deploy ?? {}),
            status,
            updatedAt: modifiedAt,
          }
        }
      }
    }
  }

  const latestScopedOrder = Math.max(
    progress?.order ?? -1,
    integration?.order ?? -1,
    deploy?.order ?? -1,
    loop?.order ?? -1,
  )

  if (
    apiError &&
    next.status !== 'completed' &&
    apiError.order >= latestScopedOrder
  ) {
    next.phase = 'blocked'
    next.status = 'blocked'
    next.lastError = apiError.text
    next.deploy = {
      ...(next.deploy ?? {}),
      status: 'blocked',
      lastEvidence: apiError.text,
      updatedAt: modifiedAt,
    }
  } else if (
    progress &&
    progress.status !== 'blocked' &&
    progress.order > (apiError?.order ?? -1)
  ) {
    next.lastError = null
  }

  return next
}
