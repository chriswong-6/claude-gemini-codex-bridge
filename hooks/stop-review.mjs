#!/usr/bin/env node
/**
 * Claude Code Stop hook — post-turn Gemini → Codex review.
 *
 * Flow:
 *   1. Claude finishes its response
 *   2. This hook fires
 *   3. If bridge is on and Claude modified files → run Gemini → Codex
 *   4. Return analysis to Claude so it can improve its answer
 *   5. Clear tracked files (prevents infinite loop on next stop)
 */

import { loadConfig }          from './lib/config.mjs'
import { initLogger, log }     from './lib/logger.mjs'
import { getMode }             from './lib/mode.mjs'
import { getSessionFiles, clearSessionFiles } from './lib/session-files.mjs'
import { summariseWithGemini } from './lib/gemini.mjs'
import { analyseWithCodex }    from './lib/codex.mjs'
import { writeTrace }          from './lib/tracer.mjs'
import { stat }                from 'fs/promises'

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

async function main() {
  const config = await loadConfig()
  initLogger(config.debug.level, config.debug.logDir)

  // Parse hook input for cwd
  let cwd = process.cwd()
  try {
    const raw = await readStdin()
    if (raw) {
      const input = JSON.parse(raw)
      cwd = input.context?.working_directory ?? cwd
    }
  } catch {}

  // Only run when bridge is on
  const mode = await getMode()
  if (mode === 'off') {
    approve()
    return
  }

  // Get files Claude modified this turn
  const allFiles = await getSessionFiles()

  // Filter to only files that actually exist
  const files = []
  for (const f of allFiles) {
    try { await stat(f); files.push(f) } catch {}
  }

  if (files.length === 0) {
    approve()
    return
  }

  // Clear NOW to prevent infinite review loop on next stop
  await clearSessionFiles()

  log(1, `stop-review: reviewing ${files.length} modified file(s)`)

  const originalPrompt = mode === 'adversarial'
    ? 'Adversarial review — find every reason these code changes should not ship.'
    : 'Code review — analyse the changes made in this turn for bugs, risks, and quality issues.'

  const t0 = Date.now()
  const trace = {
    timestamp:      new Date().toISOString(),
    toolName:       'Stop',
    filePaths:      files,
    description:    `post-turn:${mode}`,
    routing:        { delegate: true, reason: 'stop-review hook' },
    cacheHit:       false,
    gemini:         { called: false, inputFiles: files.length, outputChars: 0, latencyMs: 0, error: null },
    codex:          { called: false, inputChars: 0, outputChars: 0, latencyMs: 0, error: null, fallback: false },
    finalDecision:  '',
    totalLatencyMs: 0,
  }

  try {
    const tGemini = Date.now()
    const geminiSummary = await summariseWithGemini('Stop', files, originalPrompt, config)
    trace.gemini = { called: true, inputFiles: files.length, outputChars: geminiSummary.length, latencyMs: Date.now() - tGemini, error: null }

    const tCodex = Date.now()
    const codexResult = await analyseWithCodex(geminiSummary, originalPrompt, 'Stop', cwd, config, mode)
    trace.codex = { called: true, inputChars: geminiSummary.length, outputChars: codexResult.length, latencyMs: Date.now() - tCodex, error: null, fallback: false }

    trace.finalDecision  = 'block'
    trace.totalLatencyMs = Date.now() - t0
    await writeTrace(trace, config)

    const fileNames = files.map(f => f.split('/').pop()).join(', ')
    const label     = mode === 'adversarial' ? 'Adversarial Review' : 'Code Review'

    block([
      `## Post-turn ${label} (Gemini → Codex)`,
      `Files reviewed: ${fileNames}`,
      '',
      '### Gemini Summary',
      geminiSummary,
      '',
      `### Codex ${label}`,
      codexResult,
      '',
      '---',
      'Review the findings above and improve your response if any issues require attention.',
    ].join('\n'))

  } catch (err) {
    // Review failed — don't block Claude from finishing
    log(1, `stop-review failed: ${err.message}`)
    trace.finalDecision  = 'approve'
    trace.totalLatencyMs = Date.now() - t0
    await writeTrace(trace, config)
    approve()
  }
}

main().catch(() => approve())
