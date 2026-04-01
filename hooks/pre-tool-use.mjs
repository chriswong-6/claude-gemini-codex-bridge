#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook — Gemini context injection.
 *
 * Flow:
 *   1. Parse tool call JSON from stdin
 *   2. Track files written/edited by Claude (for Stop hook)
 *   3. Check if target files exceed the token threshold
 *   4. If within limit → approve (pass through)
 *   5. If exceeds limit:
 *      a. Check cache
 *      b. Gemini: summarise large file(s) into structured context
 *      c. Set gemini-used flag (so Stop hook runs Codex review)
 *      d. Block tool call, return Gemini summary as Claude's context
 *
 * Note: Codex runs in the Stop hook AFTER Claude responds, not here.
 * Exit codes: 0 always (never crash the hook chain).
 */

import { loadConfig }                          from './lib/config.mjs'
import { initLogger, log, logError }           from './lib/logger.mjs'
import { shouldDelegate }                      from './lib/router.mjs'
import { extractFilePaths, describeToolCall }  from './lib/paths.mjs'
import { summariseWithGemini }                 from './lib/gemini.mjs'
import { buildCacheKey, getCached, setCached } from './lib/cache.mjs'
import { writeTrace }                          from './lib/tracer.mjs'
import { addSessionFile }                      from './lib/session-files.mjs'
import { setGeminiUsed }                       from './lib/gemini-flag.mjs'
import { getPendingReview }                    from './lib/pending-review.mjs'

// ── helpers ──────────────────────────────────────────────────────────────────

function approve() {
  process.stdout.write(JSON.stringify({ decision: 'approve' }) + '\n')
}

function block(reason) {
  process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n')
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

  const trace = {
    timestamp:      new Date().toISOString(),
    toolName:       '',
    filePaths:      [],
    description:    '',
    routing:        { delegate: false, reason: '' },
    cacheHit:       false,
    gemini:         { called: false, inputFiles: 0, outputChars: 0, latencyMs: 0, error: null },
    codex:          { called: false, inputChars: 0, outputChars: 0, latencyMs: 0, error: null, fallback: false },
    finalDecision:  '',
    totalLatencyMs: 0,
  }
  const t0 = Date.now()

  // 1. Parse hook input
  let input
  try {
    const raw = await readStdin()
    if (!raw) {
      trace.finalDecision = 'approve'
      trace.routing.reason = 'empty stdin'
      await writeTrace(trace, config)
      approve()
      return
    }
    input = JSON.parse(raw)
  } catch (err) {
    logError(`Failed to parse hook input: ${err.message}`)
    trace.finalDecision = 'approve'
    trace.routing.reason = 'invalid JSON input'
    await writeTrace(trace, config)
    approve()
    return
  }

  const toolName  = input.tool_name ?? input.tool ?? ''
  const toolInput = input.tool_input ?? input.parameters ?? {}
  const cwd       = input.context?.working_directory ?? process.cwd()

  trace.toolName    = toolName
  trace.description = describeToolCall(toolName, toolInput)
  trace.filePaths   = extractFilePaths(toolName, toolInput, cwd)

  log(1, `hook fired: tool=${toolName} cwd=${cwd}`)

  // 2. Track files Claude writes/edits for post-turn Stop review
  if (['Write', 'Edit', 'MultiEdit'].includes(toolName) && toolInput.file_path) {
    await addSessionFile(toolInput.file_path)
  }

  // 3. Routing decision — delegate if file(s) exceed the token threshold,
  //    OR if a manual /bridge-review <path> command set the pending-review flag
  //    (which forces Gemini regardless of file size).
  const pendingReview = await getPendingReview()
  let { delegate, reason } = await shouldDelegate(toolName, trace.filePaths, config)
  if (!delegate && pendingReview) {
    // Manual trigger: force Gemini even for small files
    const SUPPORTED = new Set(['Read', 'Glob', 'Grep', 'Task'])
    if (SUPPORTED.has(toolName)) {
      delegate = true
      reason   = `manual trigger (${pendingReview})`
    }
  }
  trace.routing = { delegate, reason }
  log(1, `delegate=${delegate} reason="${reason}"`)

  if (!delegate) {
    trace.finalDecision  = 'approve'
    trace.totalLatencyMs = Date.now() - t0
    await writeTrace(trace, config)
    approve()
    return
  }

  // 4. Cache check
  const cacheKey = await buildCacheKey(trace.filePaths, trace.description)
  const cached   = await getCached(cacheKey, config)
  if (cached) {
    log(1, 'returning cached Gemini context')
    trace.cacheHit       = true
    trace.finalDecision  = 'block'
    trace.totalLatencyMs = Date.now() - t0
    await writeTrace(trace, config)
    await setGeminiUsed()
    block(cached)
    return
  }

  // 5. Gemini step — summarise large files into context for Claude
  let geminiSummary
  const tGemini = Date.now()
  try {
    geminiSummary = await summariseWithGemini(toolName, trace.filePaths, trace.description, config)
    trace.gemini = {
      called:      true,
      inputFiles:  trace.filePaths.length,
      outputChars: geminiSummary.length,
      latencyMs:   Date.now() - tGemini,
      error:       null,
    }
  } catch (err) {
    logError(`Gemini step failed: ${err.message}`)
    trace.gemini = { called: true, inputFiles: trace.filePaths.length, outputChars: 0, latencyMs: Date.now() - tGemini, error: err.message }
    trace.finalDecision  = 'approve'
    trace.totalLatencyMs = Date.now() - t0
    await writeTrace(trace, config)
    // Gemini failed — let Claude read the file directly
    approve()
    return
  }

  // 6. Cache and return Gemini summary as Claude's context.
  //    Codex review happens in the Stop hook after Claude responds.
  const output = formatOutput(geminiSummary, toolName, trace.filePaths.length)
  await setCached(cacheKey, output, config)
  await setGeminiUsed()

  trace.finalDecision  = 'block'
  trace.totalLatencyMs = Date.now() - t0
  await writeTrace(trace, config)
  block(output)
}

function formatOutput(geminiSummary, toolName, fileCount) {
  return [
    `## Gemini Context: ${toolName} (${fileCount} file(s))`,
    '',
    geminiSummary,
    '',
    '---',
    '_Large file(s) summarised by Gemini. Codex will review your response after this turn._',
  ].join('\n')
}

main().catch(err => {
  process.stderr.write(`[bridge] fatal: ${err.message}\n`)
  approve()
})
