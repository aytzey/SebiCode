import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

describe('SebiRalph registration', () => {
  test('keeps the bundled template name distinct from the local slash command', () => {
    const source = readFileSync(
      join(import.meta.dir, 'index.ts'),
      'utf8',
    )

    expect(source).toContain("name: 'sebiralph-template'")
    expect(source).toContain('userInvocable: false')
    expect(source).toContain('disableModelInvocation: true')
    expect(source).not.toContain("aliases: ['ralph']")
    expect(source).not.toContain("name: 'sebiralph'")
  })
})
