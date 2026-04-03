import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../services/analytics/index.js'
import { isEnvTruthy } from '../envUtils.js'

export type APIProvider = 'firstParty' | 'bedrock' | 'vertex' | 'foundry' | 'codex'

// File-based provider override — survives across Bash calls and works in remote control.
// The model can switch provider by writing to this file.
const PROVIDER_OVERRIDE_PATH = join(homedir(), '.claude', '.sebi-provider')

/**
 * Set a provider override. Persists to a file so it works from Bash (remote control).
 * Pass null to clear and fall back to env var detection.
 */
export function setProviderOverride(provider: APIProvider | null): void {
  if (provider) {
    writeFileSync(PROVIDER_OVERRIDE_PATH, provider, 'utf-8')
  } else {
    try { writeFileSync(PROVIDER_OVERRIDE_PATH, '', 'utf-8') } catch { /* ignore */ }
  }
  // Also sync env var so child processes and memoized checks pick it up
  if (provider === 'codex') {
    process.env.CLAUDE_CODE_USE_CODEX = '1'
  } else if (provider === 'firstParty' || provider === null) {
    delete process.env.CLAUDE_CODE_USE_CODEX
  }
}

export function getProviderOverride(): APIProvider | null {
  try {
    const content = readFileSync(PROVIDER_OVERRIDE_PATH, 'utf-8').trim()
    if (content === 'codex' || content === 'firstParty') return content as APIProvider
  } catch { /* file doesn't exist or unreadable */ }
  return null
}

export function getAPIProvider(): APIProvider {
  // File-based override takes precedence (set by /provider command or Bash)
  const fileOverride = getProviderOverride()
  if (fileOverride) return fileOverride

  return isEnvTruthy(process.env.CLAUDE_CODE_USE_CODEX)
    ? 'codex'
    : isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK)
      ? 'bedrock'
      : isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX)
        ? 'vertex'
        : isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)
          ? 'foundry'
          : 'firstParty'
}

export function getAPIProviderForStatsig(): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  return getAPIProvider() as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}

/**
 * Check if ANTHROPIC_BASE_URL is a first-party Anthropic API URL.
 * Returns true if not set (default API) or points to api.anthropic.com
 * (or api-staging.anthropic.com for ant users).
 */
export function isFirstPartyAnthropicBaseUrl(): boolean {
  const baseUrl = process.env.ANTHROPIC_BASE_URL
  if (!baseUrl) {
    return true
  }
  try {
    const host = new URL(baseUrl).host
    const allowedHosts = ['api.anthropic.com']
    if (process.env.USER_TYPE === 'ant') {
      allowedHosts.push('api-staging.anthropic.com')
    }
    return allowedHosts.includes(host)
  } catch {
    return false
  }
}
