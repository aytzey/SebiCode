import * as React from 'react'
import { setMainLoopModelOverride } from '../../bootstrap/state.js'
import { useSetAppState } from '../../state/AppState.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { getAPIProvider, setProviderOverride } from '../../utils/model/providers.js'
import {
  getDefaultMainLoopModelSetting,
  getPublicModelDisplayName,
  parseUserSpecifiedModel,
} from '../../utils/model/model.js'
import { clearOAuthTokenCache } from '../../utils/auth.js'

type ProviderResult = { message: string }

function switchProvider(
  target: 'claude' | 'codex',
  setAppState: ReturnType<typeof useSetAppState>,
): ProviderResult {
  const current = getAPIProvider()
  const nextProvider = target === 'codex' ? 'codex' : 'firstParty'
  const changed = current !== nextProvider

  setProviderOverride(nextProvider)
  clearOAuthTokenCache()

  const model = getDefaultMainLoopModelSetting()
  const resolvedModel = parseUserSpecifiedModel(model)
  setMainLoopModelOverride(resolvedModel)
  setAppState(prev =>
    prev.mainLoopModelForSession === resolvedModel
      ? prev
      : { ...prev, mainLoopModelForSession: resolvedModel },
  )

  const providerLabel = target === 'codex' ? 'Codex' : 'Claude'
  const displayName = getPublicModelDisplayName(model) || model
  return {
    message: `${changed ? 'Switched to' : 'Using'} **${providerLabel}**. Model: ${displayName}`,
  }
}

function showCurrentProvider(): ProviderResult {
  const provider = getAPIProvider()
  const model = getDefaultMainLoopModelSetting()
  const displayName = getPublicModelDisplayName(model) || model
  const label = provider === 'codex' ? 'Codex (OpenAI)' : 'Claude (Anthropic)'
  return { message: `Provider: **${label}** | Model: ${displayName}\n\n\`/provider claude\` or \`/provider codex\` to switch.` }
}

export default function ProviderCommand({
  args,
  onDone,
}: {
  args: string
  onDone: LocalJSXCommandOnDone
}) {
  const trimmed = args.trim().toLowerCase()
  const setAppState = useSetAppState()

  React.useEffect(() => {
    let result: ProviderResult

    if (!trimmed) {
      result = showCurrentProvider()
    } else if (trimmed === 'claude' || trimmed === 'anthropic') {
      result = switchProvider('claude', setAppState)
    } else if (trimmed === 'codex' || trimmed === 'openai' || trimmed === 'gpt') {
      result = switchProvider('codex', setAppState)
    } else if (trimmed === 'help' || trimmed === '-h') {
      result = { message: '/provider [claude|codex] — switch API provider mid-session' }
    } else {
      result = { message: `Unknown provider "${trimmed}". Use: /provider claude or /provider codex` }
    }

    onDone({
      type: 'local',
      messages: [{
        type: 'system',
        message: { type: 'system_info', title: 'Provider', message: result.message },
        uuid: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
      }],
    })
  }, [trimmed, onDone, setAppState])

  return null
}
