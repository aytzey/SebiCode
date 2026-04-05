import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ensureExecutable } from './ensureExecutable.js'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

describe('ensureExecutable', () => {
  test('adds executable bits to unix ripgrep binaries', () => {
    if (process.platform === 'win32') {
      return
    }

    const dir = mkdtempSync(join(tmpdir(), 'ripgrep-test-'))
    tempDirs.push(dir)
    const binary = join(dir, 'rg')

    writeFileSync(binary, '#!/bin/sh\nexit 0\n', 'utf8')
    chmodSync(binary, 0o644)

    ensureExecutable(binary)

    expect(statSync(binary).mode & 0o111).toBe(0o111)
  })

  test('does not throw when the binary path is missing', () => {
    expect(() => ensureExecutable(join(tmpdir(), 'missing-rg'))).not.toThrow()
  })
})
