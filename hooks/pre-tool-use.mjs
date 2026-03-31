#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook — Gemini → Codex sequential pipeline.
 *
 * Flow:
 *   1. Read tool call JSON from stdin
 *   2. Estimate token count of target files
 *   3. If within Claude's limit → approve (pass through)
 *   4. If exceeds limit:
 *      a. Check cache
 *      b. Gemini: summarise large file(s) into structured context
 *      c. Codex: deep-analyse using the Gemini summary
 *      d. Cache result
 *      e. Block tool call, return pipeline result as the tool "output"
 *
 * Exit codes: 0 always (never crash the hook chain).
 */

import { loadConfig }         from './lib/config.mjs'
import { initLogger, log, logError } from './lib/logger.mjs'
import { shouldDelegate }     from './lib/router.mjs'
import { extractFilePaths, describeToolCall } from './lib/paths.mjs'
import { summariseWithGemini } from './lib/gemini.mjs'
import { analyseWithCodex }   from './lib/codex.mjs'
import { buildCacheKey, getCached, setCached } from './lib/cache.mjs'

// ── helpers ──────────────────────────────────────────────────────────────────

function approve() {
  process.stdout.write(JSON.stringify({ decision: 'approve' }) + '\n')
}

function block(reason) {
  process.stdout.write(
    JSON.stringify({ decision: 'block', reason }) + '\n'
  )
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8').trim()
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const config = await loadConfig()
  initLogger(config.debug.level, config.debug.logDir)

  // 1. Parse hook input
  let input
  try {
    const raw = await readStdin()
    if (!raw) { approve(); return }
    input = JSON.parse(raw)
  } catch (err) {
    logError(`Failed to parse hook input: ${err.message}`)
    approve()
    return
  }

  const toolName  = input.tool_name ?? input.tool ?? ''
  const toolInput = input.tool_input ?? input.parameters ?? {}
  const cwd       = input.context?.working_directory ?? process.cwd()

  log(1, `hook fired: tool=${toolName} cwd=${cwd}`)

  // 2. Extract file paths from the tool call
  const filePaths   = extractFilePaths(toolName, toolInput, cwd)
  const description = describeToolCall(toolName, toolInput)

  // 3. Routing decision
  const { delegate, reason } = await shouldDelegate(toolName, filePaths, config)
  log(1, `delegate=${delegate} reason="${reason}"`)

  if (!delegate) {
    approve()
    return
  }

  // 4a. Cache check
  const cacheKey = await buildCacheKey(filePaths, description)
  const cached   = await getCached(cacheKey, config)
  if (cached) {
    log(1, 'returning cached pipeline result')
    block(cached)
    return
  }

  // 4b. Gemini step
  let geminiSummary
  try {
    geminiSummary = await summariseWithGemini(toolName, filePaths, description, config)
  } catch (err) {
    logError(`Gemini step failed: ${err.message}`)
    // Degrade gracefully: let Claude handle it directly
    approve()
    return
  }

  // 4c. Codex step
  let codexResult
  try {
    codexResult = await analyseWithCodex(
      geminiSummary, description, toolName, cwd, config
    )
  } catch (err) {
    logError(`Codex step failed: ${err.message} — falling back to Gemini summary`)
    // Fallback: return Gemini summary alone rather than failing completely
    codexResult = `[Codex unavailable — Gemini summary below]\n\n${geminiSummary}`
  }

  // 4d. Cache and return
  const output = formatOutput(geminiSummary, codexResult, toolName, filePaths.length)
  await setCached(cacheKey, output, config)
  block(output)
}

function formatOutput(geminiSummary, codexResult, toolName, fileCount) {
  return [
    `Pipeline result for: ${toolName} (${fileCount} file(s))`,
    '',
    '## Gemini Context Summary',
    geminiSummary,
    '',
    '## Codex Analysis',
    codexResult,
  ].join('\n')
}

main().catch(err => {
  process.stderr.write(`[bridge] fatal: ${err.message}\n`)
  approve()   // always let Claude proceed rather than hanging
})
