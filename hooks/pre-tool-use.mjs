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

import { loadConfig }                        from './lib/config.mjs'
import { initLogger, log, logError }         from './lib/logger.mjs'
import { shouldDelegate }                    from './lib/router.mjs'
import { extractFilePaths, describeToolCall } from './lib/paths.mjs'
import { summariseWithGemini }               from './lib/gemini.mjs'
import { analyseWithCodex }                  from './lib/codex.mjs'
import { buildCacheKey, getCached, setCached } from './lib/cache.mjs'
import { writeTrace }                        from './lib/tracer.mjs'

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
    timestamp:    new Date().toISOString(),
    toolName:     '',
    filePaths:    [],
    description:  '',
    routing:      { delegate: false, reason: '' },
    cacheHit:     false,
    gemini:       { called: false, inputFiles: 0, outputChars: 0, latencyMs: 0, error: null },
    codex:        { called: false, inputChars: 0, outputChars: 0, latencyMs: 0, error: null, fallback: false },
    finalDecision: '',
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

  // 2. Routing decision
  const { delegate, reason } = await shouldDelegate(toolName, trace.filePaths, config)
  trace.routing = { delegate, reason }
  log(1, `delegate=${delegate} reason="${reason}"`)

  if (!delegate) {
    trace.finalDecision = 'approve'
    trace.totalLatencyMs = Date.now() - t0
    await writeTrace(trace, config)
    approve()
    return
  }

  // 3. Cache check
  const cacheKey = await buildCacheKey(trace.filePaths, trace.description)
  const cached   = await getCached(cacheKey, config)
  if (cached) {
    log(1, 'returning cached pipeline result')
    trace.cacheHit     = true
    trace.finalDecision = 'block'
    trace.totalLatencyMs = Date.now() - t0
    await writeTrace(trace, config)
    block(cached)
    return
  }

  // 4. Gemini step
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
    approve()
    return
  }

  // 5. Codex step
  let codexResult
  const tCodex = Date.now()
  try {
    codexResult = await analyseWithCodex(geminiSummary, trace.description, toolName, cwd, config)
    trace.codex = {
      called:      true,
      inputChars:  geminiSummary.length,
      outputChars: codexResult.length,
      latencyMs:   Date.now() - tCodex,
      error:       null,
      fallback:    false,
    }
  } catch (err) {
    logError(`Codex step failed: ${err.message}`)
    trace.codex = {
      called:    true,
      inputChars: geminiSummary.length,
      outputChars: 0,
      latencyMs: Date.now() - tCodex,
      error:     err.message,
      fallback:  false,
    }
    trace.finalDecision  = 'approve'
    trace.totalLatencyMs = Date.now() - t0
    await writeTrace(trace, config)
    approve()
    return
  }

  // 6. Cache and return
  const output = formatOutput(geminiSummary, codexResult, toolName, trace.filePaths.length)
  await setCached(cacheKey, output, config)

  trace.finalDecision  = 'block'
  trace.totalLatencyMs = Date.now() - t0
  await writeTrace(trace, config)
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
  approve()
})
