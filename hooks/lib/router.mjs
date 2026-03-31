/**
 * Routing decision engine.
 * Decides whether a tool call should be sent through the Gemini → Codex pipeline.
 */

import { stat } from 'fs/promises'
import { basename } from 'path'
import { log } from './logger.mjs'

const SUPPORTED_TOOLS = new Set(['Read', 'Glob', 'Grep', 'Task'])

/**
 * @param {string} toolName
 * @param {string[]} filePaths  Absolute file paths extracted from the tool call
 * @param {object} config
 * @returns {{ delegate: boolean, reason: string }}
 */
export async function shouldDelegate(toolName, filePaths, config) {
  if (!SUPPORTED_TOOLS.has(toolName)) {
    return { delegate: false, reason: `tool ${toolName} not supported` }
  }

  // Security: reject blocked paths and excluded patterns
  for (const fp of filePaths) {
    for (const blocked of config.security.blockedPaths) {
      if (fp.startsWith(blocked)) {
        return { delegate: false, reason: `blocked path: ${fp}` }
      }
    }
    const name = basename(fp)
    for (const pat of config.security.excludePatterns) {
      if (minimatch(name, pat)) {
        return { delegate: false, reason: `excluded pattern: ${name}` }
      }
    }
  }

  // Estimate total size
  let totalBytes = 0
  let existingFiles = 0
  for (const fp of filePaths) {
    try {
      const s = await stat(fp)
      if (s.isFile()) {
        totalBytes += s.size
        existingFiles++
      }
    } catch {
      // file might not exist yet (glob result), skip
    }
  }

  const estimatedTokens = Math.floor(totalBytes / config.routing.charsPerToken)
  log(2, `files=${existingFiles} bytes=${totalBytes} ~tokens=${estimatedTokens}`)

  // Too large even for Gemini
  if (totalBytes > config.routing.maxTotalSizeBytes) {
    return { delegate: false, reason: `too large even for Gemini (${totalBytes} bytes)` }
  }

  // Large enough to need Gemini
  if (estimatedTokens > config.routing.claudeTokenLimit) {
    if (estimatedTokens <= config.routing.geminiTokenLimit) {
      return { delegate: true, reason: `~${estimatedTokens} tokens exceeds Claude limit` }
    }
    return { delegate: false, reason: `~${estimatedTokens} tokens exceeds Gemini limit` }
  }

  // Multi-file Task: delegate regardless of size
  if (toolName === 'Task' && existingFiles >= config.routing.minFilesForTask) {
    return { delegate: true, reason: `Task touching ${existingFiles} files` }
  }

  return { delegate: false, reason: `~${estimatedTokens} tokens within Claude limit` }
}

// Minimal glob matcher (only handles * and leading *.ext)
function minimatch(name, pattern) {
  if (pattern.startsWith('*.')) {
    return name.endsWith(pattern.slice(1))
  }
  if (pattern.endsWith('*')) {
    return name.startsWith(pattern.slice(0, -1))
  }
  return name === pattern
}
