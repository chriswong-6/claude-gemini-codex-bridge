#!/usr/bin/env node
/**
 * bridge-run — run the Gemini → Codex pipeline directly on one or more files,
 * bypassing the token-threshold routing check.
 *
 * Usage:
 *   node hooks/bridge-run.mjs [--mode=review|adversarial] <file> [file...]
 *   aitools review <file>
 *   aitools adversarial <file>
 */

import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { loadConfig }            from './lib/config.mjs'
import { initLogger, log }       from './lib/logger.mjs'
import { summariseWithGemini }   from './lib/gemini.mjs'
import { analyseWithCodex }      from './lib/codex.mjs'
import { buildCacheKey, getCached, setCached } from './lib/cache.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ── parse args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)

let mode = 'review'
const filePaths = []

for (const arg of args) {
  if (arg.startsWith('--mode=')) {
    mode = arg.slice('--mode='.length)
  } else {
    filePaths.push(resolve(arg))
  }
}

if (!['review', 'adversarial'].includes(mode)) {
  console.error(`Unknown mode: ${mode}. Use 'review' or 'adversarial'.`)
  process.exit(1)
}

if (filePaths.length === 0) {
  console.error('Usage: bridge-run [--mode=review|adversarial] <file> [file...]')
  process.exit(1)
}

// ── run pipeline ──────────────────────────────────────────────────────────────

async function main() {
  const config = await loadConfig()
  initLogger(config.debug.level, config.debug.logDir)

  const toolName      = 'Read'
  const originalPrompt = mode === 'adversarial'
    ? 'Adversarial review — find every reason this code should not ship.'
    : 'Code review — analyse for bugs, risks, and quality issues.'
  const cwd = process.cwd()

  const cacheKey = await buildCacheKey(filePaths, `${mode}:${originalPrompt}`)
  const cached   = await getCached(cacheKey, config)
  if (cached) {
    log(1, 'returning cached result')
    process.stdout.write(cached + '\n')
    return
  }

  log(1, `running pipeline mode=${mode} on ${filePaths.length} file(s)`)

  const geminiSummary = await summariseWithGemini(toolName, filePaths, originalPrompt, config)
  const codexResult   = await analyseWithCodex(geminiSummary, originalPrompt, toolName, cwd, config, mode)

  const label  = mode === 'adversarial' ? 'Adversarial Review' : 'Code Review'
  const output = [
    `## Gemini Context Summary`,
    geminiSummary,
    '',
    `## Codex ${label}`,
    codexResult,
  ].join('\n')

  await setCached(cacheKey, output, config)
  process.stdout.write(output + '\n')
}

main().catch(err => {
  console.error(`[bridge-run] ${err.message}`)
  process.exit(1)
})
