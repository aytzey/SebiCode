import type { Command } from '../../commands.js'

const sebiralph: Command = {
  type: 'local-jsx',
  supportsNonInteractive: true,
  name: 'sebiralph',
  aliases: ['ralph'],
  description:
    'Stateful SebiRalph harness with durable run tracking, TDD-first defaults, loop mode, and resume support',
  argumentHint: '[loop <task>|resume [run-id]|status [run-id]|<task>]',
  whenToUse:
    'When the user wants SebiRalph to run a coding harness workflow with TDD-first planning, isolated worktrees, deploy verification, autonomous refinement loops, and durable resume support',
  load: () => import('./sebiralph.js'),
} satisfies Command

export default sebiralph
