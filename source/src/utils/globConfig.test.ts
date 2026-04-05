import { describe, expect, test } from 'bun:test'
import {
  shouldGlobIncludeHiddenFiles,
  shouldGlobIncludeIgnoredFiles,
} from './globConfig.js'

describe('glob config', () => {
  test('respects gitignored files only when explicitly requested', () => {
    expect(shouldGlobIncludeIgnoredFiles(undefined)).toBe(false)
    expect(shouldGlobIncludeIgnoredFiles('')).toBe(false)
    expect(shouldGlobIncludeIgnoredFiles('false')).toBe(false)
    expect(shouldGlobIncludeIgnoredFiles('true')).toBe(true)
    expect(shouldGlobIncludeIgnoredFiles('1')).toBe(true)
  })

  test('keeps hidden files included by default', () => {
    expect(shouldGlobIncludeHiddenFiles(undefined)).toBe(true)
    expect(shouldGlobIncludeHiddenFiles('')).toBe(true)
    expect(shouldGlobIncludeHiddenFiles('false')).toBe(false)
    expect(shouldGlobIncludeHiddenFiles('0')).toBe(false)
    expect(shouldGlobIncludeHiddenFiles('true')).toBe(true)
  })
})
