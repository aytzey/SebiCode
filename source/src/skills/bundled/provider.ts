import { registerBundledSkill } from '../bundledSkills.js'
import { writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const PROVIDER_FILE = join(homedir(), '.claude', '.sebi-provider')

const VALID_PROVIDERS: Record<string, string> = {
  codex: 'codex',
  openai: 'codex',
  claude: 'firstParty',
  anthropic: 'firstParty',
  firstparty: 'firstParty',
}

export function registerProviderSkill(): void {
  registerBundledSkill({
    name: 'provider',
    description:
      'Switch the active AI provider between Claude (Anthropic) and Codex (OpenAI). Usage: /provider codex | /provider claude',
    aliases: ['prov'],
    argumentHint: 'codex | claude',
    userInvocable: true,
    disableModelInvocation: true,
    async getPromptForCommand(args) {
      const arg = (args ?? '').trim().toLowerCase()

      // No argument: show current provider
      if (!arg) {
        let current = 'firstParty'
        try {
          current = readFileSync(PROVIDER_FILE, 'utf8').trim()
        } catch {}
        const display =
          current === 'codex' ? 'Codex (gpt-5.4)' : 'Claude (Opus 4.6)'
        return [
          {
            type: 'text',
            text: `Current provider: **${display}** (\`${current}\`).\n\nUsage: \`/provider codex\` or \`/provider claude\``,
          },
        ]
      }

      // Validate argument
      const resolved = VALID_PROVIDERS[arg]
      if (!resolved) {
        return [
          {
            type: 'text',
            text: `Unknown provider "${arg}". Valid options: codex, claude`,
          },
        ]
      }

      // Write provider file
      writeFileSync(PROVIDER_FILE, resolved, 'utf8')

      const display =
        resolved === 'codex' ? 'Codex (gpt-5.4)' : 'Claude (Opus 4.6)'
      return [
        {
          type: 'text',
          text: `Switched to **${display}**. Next message will use the new model.`,
        },
      ]
    },
  })
}
