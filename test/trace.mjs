#!/usr/bin/env node
/**
 * aitools trace — watches the trace directory and prints a result
 * immediately whenever the bridge processes a real invocation.
 *
 * Usage:  aitools trace
 *
 * Keep this running in a separate terminal while using Claude Code.
 * Every time the hook fires, the result appears here within ~100ms.
 */

import { readdir, readFile, mkdir } from 'fs/promises'
import { watch } from 'fs'
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

// ── print one trace ───────────────────────────────────────────────────────────

function printTrace(t) {
  const time      = new Date(t.timestamp).toLocaleTimeString()
  const delegated = t.routing?.delegate

  console.log()
  console.log(c.bold('─'.repeat(52)))
  console.log(c.bold(`  ${time}  ·  ${t.toolName}  ·  ${t.filePaths?.length ?? 0} file(s)`))
  console.log(c.bold('─'.repeat(52)))

  // described workflow
  console.log()
  console.log(c.dim('  Described:'))
  if (!delegated) {
    console.log(`  Claude ─→ Claude ${c.dim('(small file, direct)')}`  )
  } else {
    console.log(`  Claude ─→ Gemini ─→ Codex ─→ Claude`)
  }

  // actual workflow
  console.log()
  console.log(c.dim('  Actual:'))
  if (!delegated) {
    const ok = t.finalDecision === 'approve' && !t.gemini?.called
    console.log(`  Claude ─→ ${ok ? c.green('Claude ✓') : c.red('unexpected: ' + t.finalDecision)}`)
  } else {
    const geminiOk = t.gemini?.called && !t.gemini?.error
    const codexOk  = t.codex?.called  && !t.codex?.error
    const resultOk = t.finalDecision === 'block'

    const g = geminiOk ? c.green('Gemini ✓') : c.red('Gemini ✗')
    const x = codexOk  ? c.green('Codex ✓')  : (t.codex?.fallback ? c.yellow('Codex ⚠') : c.red('Codex ✗'))
    const r = resultOk ? c.green('Claude ✓') : c.red('failed ✗')

    console.log(`  Claude ─→ ${g} ─→ ${x} ─→ ${r}`)
    console.log()

    if (t.gemini?.called) {
      const s = geminiOk ? c.green('ok') : c.red(t.gemini.error)
      console.log(`  Gemini  ${s}  ${c.dim(`${t.gemini.inputFiles} file(s) → ${t.gemini.outputChars} chars  (${t.gemini.latencyMs}ms)`)}`)
    }
    if (t.codex?.called) {
      const s = codexOk ? c.green('ok') : (t.codex.fallback ? c.yellow('fallback') : c.red(t.codex.error))
      console.log(`  Codex   ${s}  ${c.dim(`${t.codex.inputChars} chars in → ${t.codex.outputChars} chars out  (${t.codex.latencyMs}ms)`)}`)
    }
    console.log(`  Cache   ${c.dim(t.cacheHit ? 'hit' : 'miss')}    Total ${c.dim(t.totalLatencyMs + 'ms')}`)
  }

  // verdict
  const matched = delegated
    ? t.gemini?.called && !t.gemini?.error && t.codex?.called && t.finalDecision === 'block'
    : t.finalDecision === 'approve' && !t.gemini?.called

  console.log()
  if (matched) {
    console.log(c.bold(c.green('  ✓  Matches described workflow')))
  } else {
    console.log(c.bold(c.red('  ✗  Does NOT match described workflow')))
  }
  console.log()
}

// ── load a trace file safely ──────────────────────────────────────────────────

async function loadTrace(filename) {
  try {
    const raw = await readFile(join(TRACE_DIR, filename), 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

// ── watch loop ────────────────────────────────────────────────────────────────

await mkdir(TRACE_DIR, { recursive: true })

// show the latest existing trace immediately on startup (if any)
try {
  const existing = (await readdir(TRACE_DIR)).filter(f => f.endsWith('.json')).sort()
  if (existing.length) {
    const t = await loadTrace(existing.at(-1))
    if (t) printTrace(t)
  }
} catch {}

console.log(c.dim('  Watching for new invocations… (Ctrl+C to stop)'))

// debounce: a new file triggers two events (create + write), ignore the second
const pending = new Set()

watch(TRACE_DIR, async (event, filename) => {
  if (!filename?.endsWith('.json')) return
  if (pending.has(filename)) return
  pending.add(filename)

  // small delay to ensure the file is fully written before reading
  setTimeout(async () => {
    pending.delete(filename)
    const t = await loadTrace(filename)
    if (t) printTrace(t)
  }, 80)
})
