import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
  renameSync,
} from "node:fs"
import { dirname, resolve } from "node:path"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UpdateFileChunk {
  changeContext: string | null
  oldLines: string[]
  newLines: string[]
  isEndOfFile: boolean
}

export type Hunk =
  | { type: "add"; path: string; contents: string }
  | { type: "delete"; path: string }
  | {
      type: "update"
      path: string
      movePath: string | null
      chunks: UpdateFileChunk[]
    }

export interface ParsedPatch {
  hunks: Hunk[]
  patch: string
}

export interface ApplyPatchResult {
  added: string[]
  modified: string[]
  deleted: string[]
}

// ---------------------------------------------------------------------------
// Unicode normalisation helpers
// ---------------------------------------------------------------------------

/**
 * Normalize fancy Unicode punctuation and whitespace to their ASCII
 * equivalents. This is level 4 of the fuzzy matching cascade.
 */
function unicodeNormalize(s: string): string {
  let out = ""
  for (let i = 0; i < s.length; i++) {
    const cp = s.codePointAt(i)!
    // Advance past surrogate pair if needed
    if (cp > 0xffff) i++

    // Dashes: U+2010-U+2015, U+2212 -> '-'
    if ((cp >= 0x2010 && cp <= 0x2015) || cp === 0x2212) {
      out += "-"
      continue
    }
    // Single quotes: U+2018-U+201B -> "'"
    if (cp >= 0x2018 && cp <= 0x201b) {
      out += "'"
      continue
    }
    // Double quotes: U+201C-U+201F -> '"'
    if (cp >= 0x201c && cp <= 0x201f) {
      out += '"'
      continue
    }
    // Non-breaking / special spaces -> ' '
    if (
      cp === 0x00a0 ||
      (cp >= 0x2002 && cp <= 0x200a) ||
      cp === 0x202f ||
      cp === 0x205f ||
      cp === 0x3000
    ) {
      out += " "
      continue
    }

    out += String.fromCodePoint(cp)
  }
  return out
}

// ---------------------------------------------------------------------------
// Fuzzy matching – seekSequence
// ---------------------------------------------------------------------------

type LineMatcher = (a: string, b: string) => boolean

const exactMatch: LineMatcher = (a, b) => a === b

const rstripMatch: LineMatcher = (a, b) => a.trimEnd() === b.trimEnd()

const trimMatch: LineMatcher = (a, b) => a.trim() === b.trim()

const unicodeMatch: LineMatcher = (a, b) =>
  unicodeNormalize(a.trim()) === unicodeNormalize(b.trim())

const MATCH_LEVELS: LineMatcher[] = [
  exactMatch,
  rstripMatch,
  trimMatch,
  unicodeMatch,
]

/**
 * Try to find `pattern` as a contiguous sub-sequence of `lines`, starting
 * the search at index `start`.  Returns the index of the first line of the
 * match, or `undefined` if no match.
 *
 * When `eof` is true the search begins from the *end* of the file
 * (`lines.length - pattern.length`) and falls back to `start`.
 */
function seekSequence(
  lines: string[],
  pattern: string[],
  start: number,
  eof: boolean,
): number | undefined {
  if (pattern.length === 0) return start
  if (pattern.length > lines.length) return undefined

  for (const matcher of MATCH_LEVELS) {
    const result = seekWithMatcher(lines, pattern, start, eof, matcher)
    if (result !== undefined) return result
  }
  return undefined
}

function seekWithMatcher(
  lines: string[],
  pattern: string[],
  start: number,
  eof: boolean,
  matcher: LineMatcher,
): number | undefined {
  const maxStart = lines.length - pattern.length

  // Helper: check whether pattern matches at position `idx`
  const matchesAt = (idx: number): boolean => {
    for (let j = 0; j < pattern.length; j++) {
      if (!matcher(lines[idx + j]!, pattern[j]!)) return false
    }
    return true
  }

  if (eof) {
    // First try from the end
    const endStart = Math.max(0, maxStart)
    if (matchesAt(endStart)) return endStart
    // Then try searching backwards from endStart - 1 down to start
    for (let i = endStart - 1; i >= start; i--) {
      if (matchesAt(i)) return i
    }
    // Fall through to forward search from start
  }

  for (let i = start; i <= maxStart; i++) {
    if (matchesAt(i)) return i
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Parser – parsePatch
// ---------------------------------------------------------------------------

/**
 * Strip an optional heredoc wrapper around the patch text.
 * Handles `<<EOF`...`EOF` and `<<'EOF'`...`EOF` (or similar delimiters).
 */
function stripHeredoc(text: string): string {
  const lines = text.split("\n")
  if (lines.length < 2) return text

  const firstLine = lines[0]!.trim()
  // Match heredoc opening: <<DELIM or <<'DELIM' or <<"DELIM"
  const heredocMatch = firstLine.match(/^<<-?\s*['"]?(\w+)['"]?\s*$/)
  if (!heredocMatch) return text

  const delimiter = heredocMatch[1]!
  // Find matching closing delimiter from the end
  for (let i = lines.length - 1; i > 0; i--) {
    if (lines[i]!.trim() === delimiter) {
      return lines.slice(1, i).join("\n")
    }
  }
  return text
}

function isMarkerLine(line: string): boolean {
  const trimmed = line.trimStart()
  return trimmed.startsWith("*** ") || trimmed.startsWith("@@")
}

export function parsePatch(patch: string): ParsedPatch {
  let text = patch.trim()
  text = stripHeredoc(text)

  const lines = text.split("\n")
  const hunks: Hunk[] = []

  if (lines.length < 2) {
    throw new Error("Patch too short: missing Begin/End markers")
  }

  if (lines[0]!.trim() !== "*** Begin Patch") {
    throw new Error(
      `Expected "*** Begin Patch" but got: "${lines[0]!.trim()}"`,
    )
  }
  if (lines[lines.length - 1]!.trim() !== "*** End Patch") {
    throw new Error(
      `Expected "*** End Patch" but got: "${lines[lines.length - 1]!.trim()}"`,
    )
  }

  let i = 1
  const end = lines.length - 1

  while (i < end) {
    const line = lines[i]!.trim()

    // --- Add File ---
    if (line.startsWith("*** Add File: ")) {
      const path = line.slice("*** Add File: ".length).trim()
      i++
      const contentLines: string[] = []
      while (i < end) {
        const cl = lines[i]!
        if (isMarkerLine(cl) && !cl.trimStart().startsWith("@@")) break
        // For Add File, lines must be prefixed with '+'
        if (cl.startsWith("+")) {
          contentLines.push(cl.slice(1))
        } else if (cl.trim().startsWith("*** ")) {
          break
        } else {
          // Be lenient: accept lines even without '+' prefix as long as
          // they aren't markers
          contentLines.push(cl.startsWith("+") ? cl.slice(1) : cl)
        }
        i++
      }
      hunks.push({
        type: "add",
        path,
        contents: contentLines.join("\n") + "\n",
      })
      continue
    }

    // --- Delete File ---
    if (line.startsWith("*** Delete File: ")) {
      const path = line.slice("*** Delete File: ".length).trim()
      hunks.push({ type: "delete", path })
      i++
      continue
    }

    // --- Update File ---
    if (line.startsWith("*** Update File: ")) {
      const path = line.slice("*** Update File: ".length).trim()
      i++

      let movePath: string | null = null
      if (i < end && lines[i]!.trim().startsWith("*** Move to: ")) {
        movePath = lines[i]!.trim().slice("*** Move to: ".length).trim()
        i++
      }

      const chunks: UpdateFileChunk[] = []

      // Parse chunks for this file
      while (i < end) {
        const cur = lines[i]!.trim()

        // Next file-level marker → done with this file
        if (
          cur.startsWith("*** Add File: ") ||
          cur.startsWith("*** Delete File: ") ||
          cur.startsWith("*** Update File: ")
        ) {
          break
        }

        let changeContext: string | null = null

        // @@ header
        if (cur.startsWith("@@")) {
          const contextText = cur.slice(2).trim()
          changeContext = contextText.length > 0 ? contextText : null
          i++
        } else if (chunks.length > 0 && !isDiffLine(lines[i]!)) {
          // Non-diff, non-marker line between chunks → done with this file
          break
        }
        // else: first chunk without @@ header – proceed to parse diff lines

        const oldLines: string[] = []
        const newLines: string[] = []
        let isEndOfFile = false

        while (i < end) {
          const dl = lines[i]!

          // Check for end-of-file marker
          if (dl.trim() === "*** End of File") {
            isEndOfFile = true
            i++
            break
          }

          // Stop at file-level markers
          if (
            dl.trim().startsWith("*** Add File: ") ||
            dl.trim().startsWith("*** Delete File: ") ||
            dl.trim().startsWith("*** Update File: ") ||
            dl.trim().startsWith("*** Move to: ")
          ) {
            break
          }

          // Stop at next @@ (new chunk)
          if (dl.trimStart().startsWith("@@")) {
            break
          }

          if (dl.startsWith(" ")) {
            // Context line
            const content = dl.slice(1)
            oldLines.push(content)
            newLines.push(content)
            i++
          } else if (dl.startsWith("-")) {
            oldLines.push(dl.slice(1))
            i++
          } else if (dl.startsWith("+")) {
            newLines.push(dl.slice(1))
            i++
          } else if (dl === "") {
            // Empty line → empty context line
            oldLines.push("")
            newLines.push("")
            i++
          } else {
            // Non-diff line → end of chunk
            break
          }
        }

        // Only add chunk if it has content
        if (
          oldLines.length > 0 ||
          newLines.length > 0 ||
          changeContext !== null
        ) {
          chunks.push({ changeContext, oldLines, newLines, isEndOfFile })
        }
      }

      hunks.push({ type: "update", path, movePath, chunks })
      continue
    }

    // Skip unrecognised lines (lenient)
    i++
  }

  return { hunks, patch }
}

function isDiffLine(line: string): boolean {
  return (
    line.startsWith(" ") ||
    line.startsWith("-") ||
    line.startsWith("+") ||
    line === ""
  )
}

// ---------------------------------------------------------------------------
// Compute & apply replacements
// ---------------------------------------------------------------------------

interface Replacement {
  startIdx: number
  oldLen: number
  newLines: string[]
}

function computeReplacements(
  fileLines: string[],
  chunks: UpdateFileChunk[],
): Replacement[] {
  const replacements: Replacement[] = []
  let lineIndex = 0

  for (const chunk of chunks) {
    // Advance past change context if provided
    if (chunk.changeContext !== null) {
      const ctxIdx = seekSequence(
        fileLines,
        [chunk.changeContext],
        lineIndex,
        false,
      )
      if (ctxIdx !== undefined) {
        lineIndex = ctxIdx
      }
    }

    if (chunk.oldLines.length === 0) {
      // Pure addition – insert at end of file (or before trailing empty line)
      let insertIdx: number
      if (chunk.isEndOfFile || lineIndex >= fileLines.length) {
        // Insert at the very end
        insertIdx = fileLines.length
        // If file ends with an empty line, insert before it
        if (
          fileLines.length > 0 &&
          fileLines[fileLines.length - 1] === "" &&
          !chunk.isEndOfFile
        ) {
          insertIdx = fileLines.length - 1
        }
      } else {
        insertIdx = lineIndex
      }
      replacements.push({
        startIdx: insertIdx,
        oldLen: 0,
        newLines: chunk.newLines,
      })
      continue
    }

    // Try to find oldLines
    let matchIdx = seekSequence(
      fileLines,
      chunk.oldLines,
      lineIndex,
      chunk.isEndOfFile,
    )

    // EOF sentinel handling: if oldLines ends with "", retry without it
    if (
      matchIdx === undefined &&
      chunk.oldLines.length > 0 &&
      chunk.oldLines[chunk.oldLines.length - 1] === ""
    ) {
      const trimmedOld = chunk.oldLines.slice(0, -1)
      if (trimmedOld.length > 0) {
        matchIdx = seekSequence(
          fileLines,
          trimmedOld,
          lineIndex,
          chunk.isEndOfFile,
        )
        if (matchIdx !== undefined) {
          // Adjust: we matched fewer old lines
          replacements.push({
            startIdx: matchIdx,
            oldLen: trimmedOld.length,
            newLines: chunk.newLines,
          })
          lineIndex = matchIdx + trimmedOld.length
          continue
        }
      }
    }

    if (matchIdx === undefined) {
      throw new Error(
        `Could not find matching lines for chunk. ` +
          `Looking for:\n${chunk.oldLines.map((l) => `  > ${l}`).join("\n")}`,
      )
    }

    replacements.push({
      startIdx: matchIdx,
      oldLen: chunk.oldLines.length,
      newLines: chunk.newLines,
    })
    lineIndex = matchIdx + chunk.oldLines.length
  }

  // Sort by startIdx ascending (they should already be, but be safe)
  replacements.sort((a, b) => a.startIdx - b.startIdx)
  return replacements
}

function applyReplacements(
  fileLines: string[],
  replacements: Replacement[],
): string[] {
  const result = [...fileLines]
  // Apply in reverse order to avoid index shifting
  for (let i = replacements.length - 1; i >= 0; i--) {
    const r = replacements[i]!
    result.splice(r.startIdx, r.oldLen, ...r.newLines)
  }
  return result
}

// ---------------------------------------------------------------------------
// Public API – applyPatchToFile
// ---------------------------------------------------------------------------

/**
 * Apply update-file chunks to a single file.  Returns original and new
 * content strings without performing any I/O.
 */
export function applyPatchToFile(
  filePath: string,
  chunks: UpdateFileChunk[],
  cwd: string,
): { originalContent: string; newContent: string } {
  const absPath = resolve(cwd, filePath)
  const originalContent = readFileSync(absPath, "utf-8")

  // Split into lines, dropping the trailing empty element that `split`
  // produces for a file ending with `\n`.
  let fileLines = originalContent.split("\n")
  if (fileLines.length > 0 && fileLines[fileLines.length - 1] === "") {
    fileLines = fileLines.slice(0, -1)
  }

  const replacements = computeReplacements(fileLines, chunks)
  const newLines = applyReplacements(fileLines, replacements)

  // Join and ensure trailing newline
  let newContent = newLines.join("\n")
  if (!newContent.endsWith("\n")) {
    newContent += "\n"
  }

  return { originalContent, newContent }
}

// ---------------------------------------------------------------------------
// Public API – executePatch
// ---------------------------------------------------------------------------

/**
 * Parse and apply a full patch, performing file system operations.
 */
export function executePatch(patchText: string, cwd: string): ApplyPatchResult {
  const parsed = parsePatch(patchText)
  const added: string[] = []
  const modified: string[] = []
  const deleted: string[] = []

  for (const hunk of parsed.hunks) {
    switch (hunk.type) {
      case "add": {
        const absPath = resolve(cwd, hunk.path)
        mkdirSync(dirname(absPath), { recursive: true })
        writeFileSync(absPath, hunk.contents, "utf-8")
        added.push(hunk.path)
        break
      }

      case "delete": {
        const absPath = resolve(cwd, hunk.path)
        unlinkSync(absPath)
        deleted.push(hunk.path)
        break
      }

      case "update": {
        const { newContent } = applyPatchToFile(hunk.path, hunk.chunks, cwd)
        const absPath = resolve(cwd, hunk.path)

        if (hunk.movePath) {
          const newAbsPath = resolve(cwd, hunk.movePath)
          mkdirSync(dirname(newAbsPath), { recursive: true })
          writeFileSync(newAbsPath, newContent, "utf-8")
          unlinkSync(absPath)
          modified.push(hunk.movePath)
        } else {
          writeFileSync(absPath, newContent, "utf-8")
          modified.push(hunk.path)
        }
        break
      }
    }
  }

  return { added, modified, deleted }
}
