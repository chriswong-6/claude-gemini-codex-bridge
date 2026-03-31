/**
 * Path utilities — converts Claude's @-notation to absolute paths
 * and extracts file paths from tool inputs.
 */

import { resolve, join } from 'path'

/**
 * Convert a single path that may start with @ to an absolute path.
 */
export function resolveClaudePath(rawPath, cwd) {
  if (!rawPath) return ''

  // Block path traversal
  if (rawPath.includes('../') || rawPath.includes('..\\')) return ''

  let p = rawPath
  if (p.startsWith('@/')) {
    p = join(cwd, p.slice(2))
  } else if (p.startsWith('@')) {
    p = join(cwd, p.slice(1))
  } else if (!p.startsWith('/')) {
    p = join(cwd, p)
  }

  return resolve(p)
}

/**
 * Extract a list of absolute file paths from a tool call's input object.
 * Returns an empty array for unknown tools.
 */
export function extractFilePaths(toolName, toolInput, cwd) {
  switch (toolName) {
    case 'Read': {
      const p = resolveClaudePath(toolInput.file_path, cwd)
      return p ? [p] : []
    }
    case 'Glob': {
      // Glob patterns don't resolve to paths here; return the search root
      const searchPath = toolInput.path ? resolveClaudePath(toolInput.path, cwd) : cwd
      return searchPath ? [searchPath] : []
    }
    case 'Grep': {
      const p = toolInput.path ? resolveClaudePath(toolInput.path, cwd) : cwd
      return p ? [p] : []
    }
    case 'Task': {
      const prompt = toolInput.prompt ?? ''
      // Extract @ paths from the prompt text
      const matches = prompt.match(/@[^\s,;]+/g) ?? []
      return matches
        .map(m => resolveClaudePath(m, cwd))
        .filter(Boolean)
    }
    default:
      return []
  }
}

/**
 * Build a human-readable description of the tool call (used as the "original prompt").
 */
export function describeToolCall(toolName, toolInput) {
  switch (toolName) {
    case 'Read':   return `Read file: ${toolInput.file_path}`
    case 'Glob':   return `Find files matching: ${toolInput.pattern} in ${toolInput.path ?? '.'}`
    case 'Grep':   return `Search for: ${toolInput.pattern} in ${toolInput.path ?? '.'}`
    case 'Task':   return toolInput.prompt ?? 'Run task'
    default:       return `${toolName} call`
  }
}
