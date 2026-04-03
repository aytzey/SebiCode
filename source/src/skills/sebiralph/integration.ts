import { execFileSync } from 'node:child_process'

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', timeout: 30_000 }).trim()
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_')
}

export function createIntegrationBranch(sessionId: string, cwd: string): string {
  const branchName = `ralph/integration-${sanitizeId(sessionId).slice(0, 8)}`
  // Use 'git branch' instead of checkout -b to avoid switching branches
  // (checkout -b can fail with dirty working tree on switch-back)
  git(['branch', branchName], cwd)
  return branchName
}

export function createWorktreeFromIntegration(integrationBranch: string, taskId: string, cwd: string): string {
  const safeTaskId = sanitizeId(taskId)
  const worktreePath = `/tmp/ralph-worktree-${safeTaskId}`
  const taskBranch = `ralph/task-${safeTaskId}`
  git(['worktree', 'add', '-b', taskBranch, worktreePath, integrationBranch], cwd)
  return worktreePath
}

export function mergeWorktreeToIntegration(worktreePath: string, integrationBranch: string, taskId: string, cwd: string): { success: boolean; output: string } {
  const safeTaskId = sanitizeId(taskId)
  const taskBranch = `ralph/task-${safeTaskId}`
  // Remember current branch so we can restore it on failure
  const originalBranch = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)
  try {
    git(['checkout', integrationBranch], cwd)
    const output = git(['merge', '--no-ff', '-m', `ralph: merge task ${safeTaskId}`, taskBranch], cwd)
    // Switch back to original branch after successful merge
    git(['checkout', originalBranch], cwd)
    return { success: true, output }
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string }
    // Abort any in-progress merge and restore original branch
    try { git(['merge', '--abort'], cwd) } catch { /* best effort */ }
    try { git(['checkout', originalBranch], cwd) } catch { /* best effort */ }
    return { success: false, output: e.stderr || e.message || 'merge failed' }
  }
}

export function cleanupWorktree(worktreePath: string, taskId: string, cwd: string): void {
  const safeTaskId = sanitizeId(taskId)
  try { git(['worktree', 'remove', worktreePath, '--force'], cwd); git(['branch', '-D', `ralph/task-${safeTaskId}`], cwd) } catch { /* best effort */ }
}

export function cleanupIntegrationBranch(sessionId: string, cwd: string): void {
  try { git(['branch', '-D', `ralph/integration-${sanitizeId(sessionId).slice(0, 8)}`], cwd) } catch { /* best effort */ }
}
