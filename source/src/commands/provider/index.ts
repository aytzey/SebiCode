import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'provider',
  description: 'Switch API provider (claude / codex)',
  argumentHint: '[claude|codex]',
  immediate: true,
  load: () => import('./provider.js'),
} satisfies Command
