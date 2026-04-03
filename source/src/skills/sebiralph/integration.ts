import { execSync } from 'node:child_process'

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: 'utf-8', timeout: 30_000 }).trim()
}

export function createIntegrationBranch(sessionId: string, cwd: string): string {
  const branchName = `ralph/integration-${sessionId.slice(0, 8)}`
  const currentBranch = git('rev-parse --abbrev-ref HEAD', cwd)
  git(`checkout -b ${branchName}`, cwd)
  git(`checkout ${currentBranch}`, cwd)
  return branchName
}

export function createWorktreeFromIntegration(integrationBranch: string, taskId: string, cwd: string): string {
  const worktreePath = `/tmp/ralph-worktree-${taskId}`
  const taskBranch = `ralph/task-${taskId}`
  git(`worktree add -b ${taskBranch} ${worktreePath} ${integrationBranch}`, cwd)
  return worktreePath
}

export function mergeWorktreeToIntegration(worktreePath: string, integrationBranch: string, taskId: string, cwd: string): { success: boolean; output: string } {
  const taskBranch = `ralph/task-${taskId}`
  try {
    git(`checkout ${integrationBranch}`, cwd)
    const output = git(`merge --no-ff -m "ralph: merge task ${taskId}" ${taskBranch}`, cwd)
    return { success: true, output }
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string }
    return { success: false, output: e.stderr || e.message || 'merge failed' }
  }
}

export function cleanupWorktree(worktreePath: string, taskId: string, cwd: string): void {
  try { git(`worktree remove ${worktreePath} --force`, cwd); git(`branch -D ralph/task-${taskId}`, cwd) } catch { /* best effort */ }
}

export function cleanupIntegrationBranch(sessionId: string, cwd: string): void {
  try { git(`branch -D ralph/integration-${sessionId.slice(0, 8)}`, cwd) } catch { /* best effort */ }
}
