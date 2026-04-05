import { chmodSync, statSync } from 'fs'

export function ensureExecutable(
  command: string,
  onError?: (message: string) => void,
): string {
  if (process.platform === 'win32') {
    return command
  }

  try {
    const mode = statSync(command).mode & 0o777
    if ((mode & 0o111) !== 0o111) {
      chmodSync(command, mode | 0o111)
    }
  } catch (error) {
    onError?.(error instanceof Error ? error.message : String(error))
  }

  return command
}
