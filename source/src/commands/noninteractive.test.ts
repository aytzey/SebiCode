import { describe, expect, test } from 'bun:test'
import { isNonInteractiveSafeCommand } from '../types/command.js'
import type { Command } from '../types/command.js'

describe('isNonInteractiveSafeCommand', () => {
  test('allows prompt commands unless explicitly disabled', () => {
    const command = {
      type: 'prompt',
      name: 'prompt-ok',
      description: 'prompt',
      progressMessage: 'running',
      contentLength: 0,
      source: 'builtin',
      getPromptForCommand: async () => [],
    } satisfies Command

    expect(isNonInteractiveSafeCommand(command)).toBe(true)
    expect(
      isNonInteractiveSafeCommand({
        ...command,
        disableNonInteractive: true,
      }),
    ).toBe(false)
  })

  test('allows only opted-in local and local-jsx commands', () => {
    const localCommand = {
      type: 'local',
      name: 'local-ok',
      description: 'local',
      supportsNonInteractive: true,
      load: async () => ({
        call: async () => ({ type: 'skip' as const }),
      }),
    } satisfies Command

    const localJsxCommand = {
      type: 'local-jsx',
      name: 'local-jsx-ok',
      description: 'local jsx',
      supportsNonInteractive: true,
      load: async () => ({
        call: async () => null,
      }),
    } satisfies Command

    const blockedLocalJsxCommand = {
      type: 'local-jsx',
      name: 'local-jsx-blocked',
      description: 'blocked',
      load: async () => ({
        call: async () => null,
      }),
    } satisfies Command

    expect(isNonInteractiveSafeCommand(localCommand)).toBe(true)
    expect(isNonInteractiveSafeCommand(localJsxCommand)).toBe(true)
    expect(isNonInteractiveSafeCommand(blockedLocalJsxCommand)).toBe(false)
  })
})
