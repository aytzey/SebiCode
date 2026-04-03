import { execFileSync, execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { GateResult } from './types.js'

function run(cmd: string, cwd: string): { ok: boolean; output: string } {
  try {
    const output = execSync(cmd, { cwd, encoding: 'utf-8', timeout: 120_000, stdio: ['pipe', 'pipe', 'pipe'] })
    return { ok: true, output: output.trim() }
  } catch (err: unknown) {
    const e = err as { stderr?: string; stdout?: string; message?: string }
    return { ok: false, output: (e.stderr || e.stdout || e.message || 'unknown error').trim() }
  }
}

export function runPathOwnershipGate(cwd: string, ownedPaths: string[]): GateResult {
  let output: string
  try {
    output = execFileSync('git', ['diff', '--name-only', 'HEAD'], { cwd, encoding: 'utf-8', timeout: 30_000 }).trim()
  } catch {
    return { passed: false, gate: 'path-ownership', output: 'git diff failed' }
  }
  const changedFiles = output.split('\n').filter(Boolean)
  const violations = changedFiles.filter(f =>
    !ownedPaths.some(p => f === p || f.startsWith(p.endsWith('/') ? p : p + '/'))
  )
  if (violations.length > 0) {
    return { passed: false, gate: 'path-ownership', output: `Modified files outside owned paths:\n${violations.join('\n')}` }
  }
  return { passed: true, gate: 'path-ownership', output: `${changedFiles.length} files, all within owned paths` }
}

export function runBuildGate(cwd: string): GateResult {
  const cmds = [
    { test: 'package.json', cmd: 'npm run build --if-present' },
    { test: 'tsconfig.json', cmd: 'npx tsc --noEmit' },
  ]
  for (const { test, cmd } of cmds) {
    if (existsSync(join(cwd, test))) {
      const result = run(cmd, cwd)
      return { passed: result.ok, gate: 'build', output: result.output.slice(0, 2000) }
    }
  }
  return { passed: true, gate: 'build', output: 'No build system detected, skipping' }
}

export function runLintGate(cwd: string): GateResult {
  const cmds = [
    { test: 'package.json', cmd: 'npm run lint --if-present' },
    { test: 'pyproject.toml', cmd: 'ruff check .' },
  ]
  for (const { test, cmd } of cmds) {
    if (existsSync(join(cwd, test))) {
      const result = run(cmd, cwd)
      return { passed: result.ok, gate: 'lint', output: result.output.slice(0, 2000) }
    }
  }
  return { passed: true, gate: 'lint', output: 'No linter detected, skipping' }
}

export function runTestGate(cwd: string): GateResult {
  const cmds = [
    { test: 'package.json', cmd: 'npm test --if-present' },
    { test: 'pytest.ini', cmd: 'pytest' },
  ]
  for (const { test, cmd } of cmds) {
    if (existsSync(join(cwd, test))) {
      const result = run(cmd, cwd)
      return { passed: result.ok, gate: 'test', output: result.output.slice(0, 2000) }
    }
  }
  return { passed: true, gate: 'test', output: 'No test runner detected, skipping' }
}

export function runAllGates(cwd: string, ownedPaths: string[]): GateResult[] {
  return [runPathOwnershipGate(cwd, ownedPaths), runBuildGate(cwd), runLintGate(cwd), runTestGate(cwd)]
}
