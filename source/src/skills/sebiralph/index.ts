import { registerBundledSkill } from '../bundledSkills.js'
import { DEFAULT_CONFIG } from './types.js'
import { buildOrchestratorPrompt } from './orchestrator.js'

export function registerSebiRalphSkill(): void {
  registerBundledSkill({
    name: 'sebiralph',
    description: 'Dual-model orchestration: Claude plans + reviews, Codex implements. Parallel swarm with wave-based execution.',
    aliases: ['ralph'],
    whenToUse: 'When the user wants to orchestrate a complex implementation using both Claude and Codex models collaboratively',
    userInvocable: true,
    effort: 'medium',
    argumentHint: '<task description>',

    async getPromptForCommand(args: string) {
      const config = DEFAULT_CONFIG
      const orchestratorPrompt = buildOrchestratorPrompt(args, config)

      return [
        {
          type: 'text' as const,
          text: orchestratorPrompt,
        },
      ]
    },
  })
}
