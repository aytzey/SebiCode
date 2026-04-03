import * as React from 'react'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { getAPIProvider, setProviderOverride } from '../../utils/model/providers.js'
import { getDefaultMainLoopModelSetting, getPublicModelDisplayName } from '../../utils/model/model.js'
import { clearOAuthTokenCache } from '../../utils/auth.js'

type ProviderResult = { message: string }

function switchProvider(target: 'claude' | 'codex'): ProviderResult {
  const current = getAPIProvider()

  if (target === 'codex') {
    if (current === 'codex') {
      const model = getDefaultMainLoopModelSetting()
      return { message: `Already on Codex (${getPublicModelDisplayName(model) || model})` }
    }
    setProviderOverride('codex')
    clearOAuthTokenCache()
    const model = getDefaultMainLoopModelSetting()
    return { message: `Switched to **Codex**. Model: ${getPublicModelDisplayName(model) || model}` }
  } else {
    if (current === 'firstParty') {
      const model = getDefaultMainLoopModelSetting()
      return { message: `Already on Claude (${getPublicModelDisplayName(model) || model})` }
    }
    setProviderOverride('firstParty')
    clearOAuthTokenCache()
    const model = getDefaultMainLoopModelSetting()
    return { message: `Switched to **Claude**. Model: ${getPublicModelDisplayName(model) || model}` }
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

  React.useEffect(() => {
    let result: ProviderResult

    if (!trimmed) {
      result = showCurrentProvider()
    } else if (trimmed === 'claude' || trimmed === 'anthropic') {
      result = switchProvider('claude')
    } else if (trimmed === 'codex' || trimmed === 'openai' || trimmed === 'gpt') {
      result = switchProvider('codex')
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
  }, [])

  return null
}
