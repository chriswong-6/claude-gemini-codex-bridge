#!/usr/bin/env node
/**
 * Claude Code Stop hook — post-turn Codex review.
 *
 * Flow:
 *   1. Claude finishes its response
 *   2. This hook fires
 *   3. Trigger conditions (any one of):
 *      a. Bridge mode is on (review/adversarial)
 *      b. Gemini was used this turn (large file summarised in pre-tool-use)
 *      c. Manual /bridge-review <path> set the pending-review flag
 *   4. If Claude modified files → Codex reviews them directly (no Gemini step)
 *   5. Return Codex analysis to Claude so it can improve its answer
 *   6. Clear all flags (prevents infinite loop on next stop)
 */

import { loadConfig }          from './lib/config.mjs'
import { initLogger, log }     from './lib/logger.mjs'
import { getMode }             from './lib/mode.mjs'
import { getSessionFiles, clearSessionFiles } from './lib/session-files.mjs'
import { getGeminiUsed, clearGeminiUsed }     from './lib/gemini-flag.mjs'
import { getPendingReview, clearPendingReview } from './lib/pending-review.mjs'
import { analyseWithCodex }    from './lib/codex.mjs'
import { writeTrace }          from './lib/tracer.mjs'
import { stat, readFile }      from 'fs/promises'

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

async function readFilesAsContext(files) {
  const sections = []
  for (const fp of files) {
    try {
      const content = await readFile(fp, 'utf8')
      sections.push(`### ${fp}\n\`\`\`\n${content}\n\`\`\``)
    } catch {
      sections.push(`### ${fp}\n_(unreadable)_`)
    }
  }
  return sections.join('\n\n')
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

  // Trigger conditions (any one of):
  // - bridge mode is on (review/adversarial)
  // - Gemini was used this turn (file exceeded threshold, even with mode=off)
  // - A manual /bridge-review <path> command set the pending-review flag
  const mode          = await getMode()
  const geminiUsed    = await getGeminiUsed()
  const pendingReview = await getPendingReview()

  if (mode === 'off' && !geminiUsed && !pendingReview) {
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
    await clearGeminiUsed()
    await clearPendingReview()
    approve()
    return
  }

  // Clear NOW to prevent infinite review loop on next stop
  await clearSessionFiles()
  await clearGeminiUsed()
  await clearPendingReview()

  log(1, `stop-review: reviewing ${files.length} modified file(s) with Codex`)

  // Determine review type:
  // - mode=on → use mode value (review/adversarial)
  // - mode=off + pending-review → use pending-review value (manual trigger)
  // - mode=off + gemini-used → 'auto' (large file threshold)
  const reviewMode = mode !== 'off'
    ? mode
    : (pendingReview ?? (geminiUsed ? 'auto' : 'review'))

  const originalPrompt = reviewMode === 'adversarial'
    ? 'Adversarial review — find every reason these code changes should not ship.'
    : 'Code review — analyse the changes made in this turn for bugs, risks, and quality issues.'

  const t0 = Date.now()
  const trace = {
    timestamp:      new Date().toISOString(),
    toolName:       'Stop',
    filePaths:      files,
    description:    `post-turn:${reviewMode}`,
    routing:        { delegate: true, reason: pendingReview ? `manual:${pendingReview}` : (geminiUsed ? 'gemini-used-this-turn' : 'mode-on') },
    cacheHit:       false,
    gemini:         { called: false, inputFiles: 0, outputChars: 0, latencyMs: 0, error: null },
    codex:          { called: false, inputChars: 0, outputChars: 0, latencyMs: 0, error: null, fallback: false },
    finalDecision:  '',
    totalLatencyMs: 0,
  }

  try {
    // Read file contents directly — no Gemini step in Stop hook
    const fileContents = await readFilesAsContext(files)

    const tCodex = Date.now()
    const codexResult = await analyseWithCodex(fileContents, originalPrompt, 'Stop', cwd, config, reviewMode)
    trace.codex = {
      called:      true,
      inputChars:  fileContents.length,
      outputChars: codexResult.length,
      latencyMs:   Date.now() - tCodex,
      error:       null,
      fallback:    false,
    }

    trace.finalDecision  = 'block'
    trace.totalLatencyMs = Date.now() - t0
    await writeTrace(trace, config)

    const fileNames = files.map(f => f.split('/').pop()).join(', ')
    const label     = reviewMode === 'adversarial' ? 'Adversarial Review' : 'Code Review'

    block([
      `## Post-turn ${label} (Codex)`,
      `Files reviewed: ${fileNames}`,
      '',
      codexResult,
      '',
      '---',
      'Review the findings above and improve your response if any issues require attention.',
    ].join('\n'))

  } catch (err) {
    log(1, `stop-review failed: ${err.message}`)
    trace.finalDecision  = 'approve'
    trace.totalLatencyMs = Date.now() - t0
    await writeTrace(trace, config)
    approve()
  }
}

main().catch(() => approve())
