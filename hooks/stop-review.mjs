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
 *   4. Determine files to review:
 *      - If Claude wrote/modified files this turn → review those (session files)
 *      - Else if manual trigger with paths → review those paths (read-only analysis)
 *      - Else → nothing to review, approve
 *   5. Codex reviews file contents directly (no Gemini step)
 *   6. Return Codex analysis to Claude so it can improve its answer
 *   7. Clear all flags (prevents infinite loop on next stop)
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

const MAX_CONTEXT_CHARS = 80000  // ~20k tokens — hard cap for Codex input

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
  let total = 0
  for (const fp of files) {
    if (total >= MAX_CONTEXT_CHARS) {
      sections.push(`### ${fp}\n_(omitted — context limit reached)_`)
      continue
    }
    try {
      let content = await readFile(fp, 'utf8')
      const remaining = MAX_CONTEXT_CHARS - total
      if (content.length > remaining) {
        content = content.slice(0, remaining) + '\n... (truncated)'
      }
      total += content.length
      sections.push(`### ${fp}\n\`\`\`\n${content}\n\`\`\``)
    } catch {
      sections.push(`### ${fp}\n_(unreadable)_`)
    }
  }
  return sections.join('\n\n')
}

async function filterExisting(paths) {
  const result = []
  for (const f of paths) {
    try { await stat(f); result.push(f) } catch {}
  }
  return result
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

  // Determine files to review:
  // Priority 1: files Claude wrote/modified this turn (session files)
  // Priority 2: paths from manual /bridge-review <path> command
  const sessionFiles = await filterExisting(await getSessionFiles())
  const files = sessionFiles.length > 0
    ? sessionFiles
    : await filterExisting(pendingReview?.paths ?? [])

  if (files.length === 0) {
    await clearSessionFiles()
    await clearGeminiUsed()
    await clearPendingReview()
    approve()
    return
  }

  // Clear NOW to prevent infinite review loop on next stop
  await clearSessionFiles()
  await clearGeminiUsed()
  await clearPendingReview()

  log(1, `stop-review: reviewing ${files.length} file(s) with Codex`)

  // Determine review type:
  // - mode=on → use mode value (review/adversarial)
  // - mode=off + pending-review → use pending-review type (manual trigger)
  // - mode=off + gemini-used → 'auto' (large file threshold)
  const reviewMode = mode !== 'off'
    ? mode
    : (pendingReview?.type ?? (geminiUsed ? 'auto' : 'review'))

  const reviewSource = sessionFiles.length > 0 ? 'claude-writes' : 'manual-paths'
  const originalPrompt = reviewMode === 'adversarial'
    ? 'Adversarial review — find every reason these code changes should not ship.'
    : 'Code review — analyse the changes made in this turn for bugs, risks, and quality issues.'

  const t0 = Date.now()
  const trace = {
    timestamp:      new Date().toISOString(),
    toolName:       'Stop',
    filePaths:      files,
    description:    `post-turn:${reviewMode}`,
    routing:        { delegate: true, reason: pendingReview ? `manual:${pendingReview.type}:${reviewSource}` : (geminiUsed ? 'gemini-used-this-turn' : 'mode-on') },
    cacheHit:       false,
    gemini:         { called: false, inputFiles: 0, outputChars: 0, latencyMs: 0, error: null },
    codex:          { called: false, inputChars: 0, outputChars: 0, latencyMs: 0, error: null, fallback: false },
    finalDecision:  '',
    totalLatencyMs: 0,
  }

  try {
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
