function isTruthyFlag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') {
    return fallback
  }

  const normalized = value.toLowerCase().trim()
  return ['1', 'true', 'yes', 'on'].includes(normalized)
}

export function shouldGlobIncludeIgnoredFiles(
  envValue = process.env.CLAUDE_CODE_GLOB_NO_IGNORE,
): boolean {
  return isTruthyFlag(envValue, false)
}

export function shouldGlobIncludeHiddenFiles(
  envValue = process.env.CLAUDE_CODE_GLOB_HIDDEN,
): boolean {
  return isTruthyFlag(envValue, true)
}
