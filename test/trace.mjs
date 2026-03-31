#!/usr/bin/env node
/**
 * aitools trace — reads the latest hook trace and shows whether
 * the actual data flow matched the described pipeline.
 *
 * Usage:  aitools trace
 */

import { readdir, readFile } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'

const TRACE_DIR = process.env.TRACE_DIR
  ?? join(homedir(), '.claude-gemini-codex-bridge', 'traces')

const isTTY = process.stdout.isTTY
const c = {
  green:  s => isTTY ? `\x1b[32m${s}\x1b[0m` : s,
  red:    s => isTTY ? `\x1b[31m${s}\x1b[0m` : s,
  yellow: s => isTTY ? `\x1b[33m${s}\x1b[0m` : s,
  bold:   s => isTTY ? `\x1b[1m${s}\x1b[0m`  : s,
  dim:    s => isTTY ? `\x1b[2m${s}\x1b[0m`  : s,
}

// ── load latest trace ─────────────────────────────────────────────────────────

async function loadLatest() {
  let files
  try {
    files = (await readdir(TRACE_DIR)).filter(f => f.endsWith('.json')).sort()
  } catch {
    return null
  }
  if (!files.length) return null
  const raw = await readFile(join(TRACE_DIR, files.at(-1)), 'utf8')
  return JSON.parse(raw)
}

// ── main ──────────────────────────────────────────────────────────────────────

const t = await loadLatest()

if (!t) {
  console.log('\nNo traces yet.')
  console.log(c.dim('Use Claude Code normally with the bridge installed, then run aitools trace.\n'))
  process.exit(0)
}

const time  = new Date(t.timestamp).toLocaleString()
const delegated = t.routing?.delegate

console.log()
console.log(c.bold('Invocation'))
console.log(`  Time   : ${time}`)
console.log(`  Tool   : ${t.toolName}`)
console.log(`  Files  : ${t.filePaths?.length ?? 0}`)
console.log(`  Reason : ${t.routing?.reason ?? '-'}`)

console.log()
console.log(c.bold('Described workflow'))
if (!delegated) {
  console.log(`  Claude ${c.dim('─→')} tool call ${c.dim('─→')} ${c.dim('Claude handles directly')}`)
} else {
  console.log(`  Claude ${c.dim('─→')} Gemini ${c.dim('─→')} Codex ${c.dim('─→')} result back to Claude`)
}

console.log()
console.log(c.bold('Actual workflow'))

if (!delegated) {
  // pass-through path
  const ok = t.finalDecision === 'approve' && !t.gemini?.called
  const icon = ok ? c.green('✓') : c.red('✗')
  console.log(`  ${icon} Claude ${c.dim('─→')} ${ok ? c.green('passed through to Claude') : c.red('unexpected: ' + t.finalDecision)}`)

} else {
  // delegation path — show each step
  const geminiOk = t.gemini?.called && !t.gemini?.error
  const codexOk  = t.codex?.called  && !t.codex?.error
  const resultOk = t.finalDecision === 'block'

  const g = geminiOk ? c.green('Gemini ✓') : c.red('Gemini ✗')
  const x = codexOk  ? c.green('Codex ✓')  : (t.codex?.fallback ? c.yellow('Codex (fallback)') : c.red('Codex ✗'))
  const r = resultOk ? c.green('result → Claude ✓') : c.red('result missing ✗')

  console.log(`  Claude ${c.dim('─→')} ${g} ${c.dim('─→')} ${x} ${c.dim('─→')} ${r}`)
  console.log()

  // step detail
  if (t.gemini?.called) {
    const status = geminiOk ? c.green('ok') : c.red(t.gemini.error)
    console.log(`  Gemini : ${status}  ${c.dim(`${t.gemini.inputFiles} file(s) → ${t.gemini.outputChars} chars  (${t.gemini.latencyMs}ms)`)}`)
  }
  if (t.codex?.called) {
    const status = codexOk ? c.green('ok') : (t.codex.fallback ? c.yellow('fallback') : c.red(t.codex.error))
    console.log(`  Codex  : ${status}  ${c.dim(`${t.codex.inputChars} chars in → ${t.codex.outputChars} chars out  (${t.codex.latencyMs}ms)`)}`)
  }
  console.log(`  Cache  : ${c.dim(t.cacheHit ? 'hit' : 'miss')}`)
  console.log(`  Total  : ${c.dim(t.totalLatencyMs + 'ms')}`)
}

// ── verdict ───────────────────────────────────────────────────────────────────

console.log()

const matched = delegated
  ? t.gemini?.called && !t.gemini?.error && t.codex?.called && t.finalDecision === 'block'
  : t.finalDecision === 'approve' && !t.gemini?.called

if (matched) {
  console.log(c.bold(c.green('✓  Matches described workflow.')))
} else {
  console.log(c.bold(c.red('✗  Does NOT match described workflow.')))
}
console.log()
