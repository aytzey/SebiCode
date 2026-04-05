import { sep } from 'path'
import * as React from 'react'
import { logEvent } from 'src/services/analytics/index.js'
import { z } from 'zod/v4'
import { diagnosticTracker } from '../../services/diagnosticTracking.js'
import { clearDeliveredDiagnosticsForFile } from '../../services/lsp/LSPDiagnosticRegistry.js'
import { getLspServerManager } from '../../services/lsp/manager.js'
import {
  activateConditionalSkillsForPaths,
  addSkillDirectories,
  discoverSkillDirsForPaths,
} from '../../skills/loadSkillsDir.js'
import type { ToolUseContext } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import {
  getFileModificationTime,
} from '../../utils/file.js'
import {
  fileHistoryEnabled,
  fileHistoryTrackEdit,
} from '../../utils/fileHistory.js'
import { logFileOperation } from '../../utils/fileOperationAnalytics.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logError } from '../../utils/log.js'
import { expandPath } from '../../utils/path.js'
import {
  checkWritePermissionForTool,
} from '../../utils/permissions/filesystem.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import { matchWildcardPattern } from '../../utils/permissions/shellRuleMatching.js'
import { Box, Text } from '../../ink.js'
import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js'
import { readFileSync } from 'fs'
import { executePatch } from './applyPatch.js'

// ── Constants ────────────────────────────────────────────────────────────────

export const APPLY_PATCH_TOOL_NAME = 'apply_patch'

// ── Schemas ──────────────────────────────────────────────────────────────────

const inputSchema = lazySchema(() =>
  z.strictObject({
    patch: z
      .string()
      .describe('The patch content in apply_patch format'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

export type ApplyPatchInput = z.output<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    added: z.array(z.string()).describe('Files that were created'),
    modified: z.array(z.string()).describe('Files that were modified'),
    deleted: z.array(z.string()).describe('Files that were deleted'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type ApplyPatchOutput = z.infer<OutputSchema>

// ── UI helpers ───────────────────────────────────────────────────────────────

function userFacingName(
  _input?: Partial<{ patch: string }>,
): string {
  return 'Patch'
}

function getToolUseSummary(
  input?: Partial<{ patch: string }>,
): string | null {
  if (!input?.patch) return null
  // Count operations in the patch to give a brief summary
  const adds = (input.patch.match(/\*\*\* Add File:/g) || []).length
  const updates = (input.patch.match(/\*\*\* Update File:/g) || []).length
  const deletes = (input.patch.match(/\*\*\* Delete File:/g) || []).length
  const parts: string[] = []
  if (adds > 0) parts.push(`+${adds}`)
  if (updates > 0) parts.push(`~${updates}`)
  if (deletes > 0) parts.push(`-${deletes}`)
  return parts.length > 0 ? parts.join(' ') : null
}

function renderToolUseMessage(
  input: Partial<{ patch: string }>,
  { verbose }: { verbose: boolean },
): React.ReactNode {
  const summary = getToolUseSummary(input)
  if (!summary) return null
  return <Text>{summary} file(s)</Text>
}

function renderToolResultMessage(
  data: ApplyPatchOutput,
  _progressMessages: unknown[],
  { verbose }: { verbose: boolean },
): React.ReactNode {
  if (!data) return null
  const { added, modified, deleted } = data
  const total = added.length + modified.length + deleted.length
  if (total === 0) {
    return <Text>No files changed</Text>
  }
  return (
    <Box flexDirection="column">
      {added.length > 0 && (
        <Text color="green">
          Added: {added.join(', ')}
        </Text>
      )}
      {modified.length > 0 && (
        <Text color="yellow">
          Modified: {modified.join(', ')}
        </Text>
      )}
      {deleted.length > 0 && (
        <Text color="red">
          Deleted: {deleted.join(', ')}
        </Text>
      )}
    </Box>
  )
}

function renderToolUseRejectedMessage(
  _input: { patch: string },
  _options: { style?: 'condensed'; verbose: boolean },
): React.ReactNode {
  return <Text color="red">Patch rejected</Text>
}

function renderToolUseErrorMessage(
  result: unknown,
  options: {
    verbose: boolean
    isAborted?: boolean
  },
): React.ReactNode {
  return (
    <FallbackToolUseErrorMessage
      result={result as string | Array<{ type: string; text?: string }>}
      verbose={options.verbose}
    />
  )
}

// ── Tool Definition ──────────────────────────────────────────────────────────

export const ApplyPatchTool = buildTool({
  name: APPLY_PATCH_TOOL_NAME,
  searchHint: 'apply multi-file patches with fuzzy matching',
  maxResultSizeChars: 100_000,
  strict: true,

  async description() {
    return 'Apply a patch to create, update, or delete files.'
  },

  async prompt() {
    return `Apply a patch to create, update, or delete files. Supports multiple file operations in a single call with fuzzy matching for reliable edits.

Patch format:
*** Begin Patch
*** Add File: path/to/new/file.ts
+line 1
+line 2
*** Update File: path/to/existing.ts
@@ context_line_to_locate_change
-old line to remove
+new line to add
 context line (unchanged)
*** Delete File: path/to/remove.ts
*** End Patch

Rules:
- Each line in a hunk must start with '+' (add), '-' (remove), or ' ' (context)
- Use @@ with optional context to locate changes: @@ def function_name():
- Multiple @@ markers narrow the location (class \u2192 method \u2192 line)
- Paths must be relative to the project root
- Empty lines in hunks are treated as context lines`
  },

  userFacingName,
  getToolUseSummary,

  getActivityDescription(input) {
    const summary = getToolUseSummary(input)
    return summary ? `Applying patch (${summary})` : 'Applying patch'
  },

  get inputSchema(): InputSchema {
    return inputSchema()
  },

  get outputSchema(): OutputSchema {
    return outputSchema()
  },

  toAutoClassifierInput(input) {
    return input.patch ?? ''
  },

  getPath(_input): string | undefined {
    // Patches can touch multiple files; no single path
    return undefined
  },

  async preparePermissionMatcher({ patch }) {
    // Extract all file paths from the patch for permission matching
    const paths: string[] = []
    const cwd = getCwd()
    for (const match of (patch ?? '').matchAll(
      /\*\*\*\s+(?:Add|Update|Delete)\s+File:\s*(.+)/g,
    )) {
      const rel = match[1]!.trim()
      paths.push(expandPath(`${cwd}/${rel}`))
    }
    return (pattern: string) =>
      paths.some(p => matchWildcardPattern(pattern, p))
  },

  async checkPermissions(input, context): Promise<PermissionDecision> {
    const appState = context.getAppState()
    return checkWritePermissionForTool(
      ApplyPatchTool,
      input,
      appState.toolPermissionContext,
    )
  },

  renderToolUseMessage,
  renderToolResultMessage,
  renderToolUseRejectedMessage,
  renderToolUseErrorMessage,

  async validateInput(input: ApplyPatchInput, _toolUseContext: ToolUseContext) {
    const { patch } = input

    if (!patch || patch.trim().length === 0) {
      return {
        result: false,
        message: 'Patch content is empty.',
        errorCode: 1,
      }
    }

    if (!patch.includes('*** Begin Patch')) {
      return {
        result: false,
        message:
          'Patch must start with "*** Begin Patch". See the tool description for the correct format.',
        errorCode: 2,
      }
    }

    if (!patch.includes('*** End Patch')) {
      return {
        result: false,
        message:
          'Patch must end with "*** End Patch". See the tool description for the correct format.',
        errorCode: 3,
      }
    }

    return { result: true }
  },

  async call(
    input: ApplyPatchInput,
    {
      readFileState,
      updateFileHistoryState,
      dynamicSkillDirTriggers,
    },
    _,
    parentMessage,
  ) {
    const { patch } = input
    const cwd = getCwd()

    // Execute the patch (synchronous)
    const result = executePatch(patch, cwd)

    const allPaths = [
      ...result.added,
      ...result.modified,
      ...result.deleted,
    ].map(f => expandPath(`${cwd}/${f}`))

    // Discover skills from touched paths (fire-and-forget)
    if (!isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)) {
      const newSkillDirs = await discoverSkillDirsForPaths(allPaths, cwd)
      if (newSkillDirs.length > 0) {
        for (const dir of newSkillDirs) {
          dynamicSkillDirTriggers?.add(dir)
        }
        addSkillDirectories(newSkillDirs).catch(() => {})
      }
      activateConditionalSkillsForPaths(allPaths, cwd)
    }

    // Notify diagnostics tracker, LSP, and VSCode for each touched file
    const lspManager = getLspServerManager()
    for (const absPath of allPaths) {
      await diagnosticTracker.beforeFileEdited(absPath)

      if (fileHistoryEnabled()) {
        await fileHistoryTrackEdit(
          updateFileHistoryState,
          absPath,
          parentMessage.uuid,
        )
      }

      // Update read timestamp so subsequent edits know the file state
      try {
        const content = readFileSync(absPath, 'utf8')
        readFileState.set(absPath, {
          content,
          timestamp: getFileModificationTime(absPath),
          offset: undefined,
          limit: undefined,
        })
      } catch {
        // File was deleted or doesn't exist — remove from state
        readFileState.delete(absPath)
      }

      if (lspManager) {
        clearDeliveredDiagnosticsForFile(`file://${absPath}`)
        try {
          const content = readFileSync(absPath, 'utf8')
          lspManager.changeFile(absPath, content).catch((err: Error) => {
            logForDebugging(
              `LSP: Failed to notify server of file change for ${absPath}: ${err.message}`,
            )
            logError(err)
          })
          lspManager.saveFile(absPath).catch((err: Error) => {
            logForDebugging(
              `LSP: Failed to notify server of file save for ${absPath}: ${err.message}`,
            )
            logError(err)
          })
        } catch {
          // File was deleted — skip LSP notification
        }
      }

      logFileOperation({
        operation: 'edit',
        tool: 'ApplyPatchTool',
        filePath: absPath,
      })
    }

    // Log CLAUDE.md writes
    for (const absPath of allPaths) {
      if (absPath.endsWith(`${sep}CLAUDE.md`)) {
        logEvent('tengu_write_claudemd', {})
      }
    }

    logEvent('tengu_apply_patch', {
      added: result.added.length,
      modified: result.modified.length,
      deleted: result.deleted.length,
    })

    return {
      data: {
        added: result.added,
        modified: result.modified,
        deleted: result.deleted,
      },
    }
  },

  mapToolResultToToolResultBlockParam(data: ApplyPatchOutput, toolUseID) {
    const { added, modified, deleted } = data
    const parts: string[] = []

    if (added.length > 0) {
      parts.push(`Added: ${added.join(', ')}`)
    }
    if (modified.length > 0) {
      parts.push(`Modified: ${modified.join(', ')}`)
    }
    if (deleted.length > 0) {
      parts.push(`Deleted: ${deleted.join(', ')}`)
    }

    const content =
      parts.length > 0
        ? `Patch applied successfully. ${parts.join('. ')}.`
        : 'Patch applied with no file changes.'

    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content,
    }
  },
} satisfies ToolDef<InputSchema, ApplyPatchOutput>)
