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

import { dirname, join, resolve, extname } from 'path'
import { fileURLToPath } from 'url'
import { stat, readdir, writeFile, mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { loadConfig }            from './lib/config.mjs'
import { initLogger, log }       from './lib/logger.mjs'
import { summariseWithGemini }   from './lib/gemini.mjs'
import { analyseWithCodex }      from './lib/codex.mjs'
import { buildCacheKey, getCached, setCached } from './lib/cache.mjs'
import { writeTrace }            from './lib/tracer.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Directories to always skip when walking
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next',
  'artifacts', 'cache', 'coverage', '__pycache__', '.venv',
])

// Source file extensions to include
const SOURCE_EXTS = new Set([
  '.ts', '.js', '.mjs', '.cjs', '.sol', '.py', '.go', '.rs',
  '.java', '.kt', '.swift', '.c', '.cpp', '.h', '.cs',
  '.json', '.yaml', '.yml', '.toml', '.md', '.txt',
])

async function expandPath(p) {
  const s = await stat(p).catch(() => null)
  if (!s) return []
  if (s.isFile()) return [p]
  if (!s.isDirectory()) return []

  // Walk directory
  const results = []
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.env') continue
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(join(dir, entry.name))
      } else if (entry.isFile()) {
        if (SOURCE_EXTS.has(extname(entry.name).toLowerCase())) {
          results.push(join(dir, entry.name))
        }
      }
    }
  }
  await walk(p)
  return results
}

// ── parse args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)

let mode = 'review'
let textInput = null
const filePaths = []

const rawPaths = []
for (const arg of args) {
  if (arg.startsWith('--mode=')) {
    mode = arg.slice('--mode='.length)
  } else if (arg.startsWith('--text=')) {
    textInput = arg.slice('--text='.length)
  } else {
    rawPaths.push(resolve(arg))
  }
}

// If --text was provided, write it to a temp file and use that
if (textInput !== null) {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-'))
  const tmpFile = join(dir, 'input.txt')
  await writeFile(tmpFile, textInput, 'utf8')
  filePaths.push(tmpFile)
} else {
  // Expand directories into individual source files
  for (const p of rawPaths) {
    const expanded = await expandPath(p)
    filePaths.push(...expanded)
  }

  if (rawPaths.length > 0 && filePaths.length === 0) {
    console.error(`[bridge-run] No source files found in: ${rawPaths.join(', ')}`)
    process.exit(1)
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

  const toolName       = 'Read'
  const originalPrompt = mode === 'adversarial'
    ? 'Adversarial review — find every reason this code should not ship.'
    : 'Code review — analyse for bugs, risks, and quality issues.'
  const cwd = process.cwd()
  const t0  = Date.now()

  const trace = {
    timestamp:     new Date().toISOString(),
    toolName,
    filePaths,
    description:   `manual:${mode}`,
    routing:       { delegate: true, reason: `manual ${mode} command` },
    cacheHit:      false,
    gemini:        { called: false, inputFiles: filePaths.length, outputChars: 0, latencyMs: 0, error: null },
    codex:         { called: false, inputChars: 0, outputChars: 0, latencyMs: 0, error: null, fallback: false },
    finalDecision: '',
    totalLatencyMs: 0,
  }

  const cacheKey = await buildCacheKey(filePaths, `${mode}:${originalPrompt}`)
  const cached   = await getCached(cacheKey, config)
  if (cached) {
    log(1, 'returning cached result')
    trace.cacheHit      = true
    trace.finalDecision = 'block'
    trace.totalLatencyMs = Date.now() - t0
    await writeTrace(trace, config)
    process.stdout.write(cached + '\n')
    return
  }

  log(1, `running pipeline mode=${mode} on ${filePaths.length} file(s)`)

  const tGemini = Date.now()
  const geminiSummary = await summariseWithGemini(toolName, filePaths, originalPrompt, config)
  trace.gemini = { called: true, inputFiles: filePaths.length, outputChars: geminiSummary.length, latencyMs: Date.now() - tGemini, error: null }

  const tCodex = Date.now()
  const codexResult = await analyseWithCodex(geminiSummary, originalPrompt, toolName, cwd, config, mode)
  trace.codex = { called: true, inputChars: geminiSummary.length, outputChars: codexResult.length, latencyMs: Date.now() - tCodex, error: null, fallback: false }

  const label  = mode === 'adversarial' ? 'Adversarial Review' : 'Code Review'
  const output = [
    `## Gemini Context Summary`,
    geminiSummary,
    '',
    `## Codex ${label}`,
    codexResult,
  ].join('\n')

  trace.finalDecision  = 'block'
  trace.totalLatencyMs = Date.now() - t0
  await writeTrace(trace, config)

  await setCached(cacheKey, output, config)
  process.stdout.write(output + '\n')
}

main().catch(err => {
  console.error(`[bridge-run] ${err.message}`)
  process.exit(1)
})
