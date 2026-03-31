#!/usr/bin/env node
/**
 * aitools trace — reads the latest hook trace file and validates
 * whether the data actually flowed as described in the pipeline spec.
 *
 * Usage:
 *   aitools trace          # check the latest trace
 *   aitools trace --all    # check all traces from today
 *   aitools trace --watch  # re-run every 2s, shows new traces as they arrive
 *
 * Described pipeline (what we're validating against):
 *
 *   Claude triggers tool call
 *       │
 *       ▼
 *   Token estimate > 50k?
 *       ├── No  → approve (Claude handles directly)
 *       └── Yes → Gemini summarises large context
 *                     │
 *                     ▼
 *                 Codex analyses Gemini summary
 *                     │
 *                     ▼
 *                 Result injected back into Claude
 */

import { readdir, readFile } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'

const TRACE_DIR = process.env.TRACE_DIR
  ?? join(homedir(), '.claude-gemini-codex-bridge', 'traces')

const ALL   = process.argv.includes('--all')
const WATCH = process.argv.includes('--watch')

// ── terminal colours ──────────────────────────────────────────────────────────
const isTTY = process.stdout.isTTY
const c = {
  green:  s => isTTY ? `\x1b[32m${s}\x1b[0m` : s,
  red:    s => isTTY ? `\x1b[31m${s}\x1b[0m` : s,
  yellow: s => isTTY ? `\x1b[33m${s}\x1b[0m` : s,
  cyan:   s => isTTY ? `\x1b[36m${s}\x1b[0m` : s,
  bold:   s => isTTY ? `\x1b[1m${s}\x1b[0m`  : s,
  dim:    s => isTTY ? `\x1b[2m${s}\x1b[0m`  : s,
}

const PASS = c.green('✓')
const FAIL = c.red('✗')
const WARN = c.yellow('!')
const ARROW = c.dim('→')

// ── pipeline spec ─────────────────────────────────────────────────────────────
// Each check returns { ok, label, detail }

function checks(t) {
  return [
    // Step 1: hook received a valid tool call
    {
      label: 'Tool call received',
      ok:    !!t.toolName,
      detail: t.toolName ? `${t.toolName}: ${t.description}` : 'toolName missing',
    },

    // Step 2: routing decision was made
    {
      label: 'Routing decision made',
      ok:    typeof t.routing?.delegate === 'boolean',
      detail: t.routing?.reason ?? 'no routing info',
    },

    // Step 3a: pass-through path — small file should not call Gemini
    ...(t.routing?.delegate === false ? [{
      label: 'Small file: passed through to Claude',
      ok:    t.finalDecision === 'approve' && !t.gemini?.called,
      detail: t.finalDecision === 'approve'
        ? `approve — ${t.routing.reason}`
        : `unexpected decision: ${t.finalDecision}`,
    }] : []),

    // Step 3b: delegation path — Gemini must be called first
    ...(t.routing?.delegate === true ? [
      {
        label: 'Large file: Gemini called first',
        ok:    t.gemini?.called === true,
        detail: t.gemini?.called
          ? `${t.gemini.inputFiles} file(s) → ${t.gemini.outputChars} chars summary (${t.gemini.latencyMs}ms)`
          : `Gemini was NOT called — error: ${t.gemini?.error ?? 'unknown'}`,
      },
      {
        label: 'Gemini produced a summary',
        ok:    (t.gemini?.outputChars ?? 0) > 50,
        detail: t.gemini?.outputChars
          ? `${t.gemini.outputChars} chars`
          : 'empty or missing summary',
      },
      {
        label: 'Codex called after Gemini',
        ok:    t.codex?.called === true,
        detail: t.codex?.called
          ? t.codex.fallback
            ? c.yellow(`fallback mode — ${t.codex.error}`)
            : `${t.codex.inputChars} chars in → ${t.codex.outputChars} chars out (${t.codex.latencyMs}ms)`
          : `Codex was NOT called — error: ${t.codex?.error ?? 'unknown'}`,
      },
      {
        label: 'Codex received Gemini summary as input',
        ok:    (t.codex?.inputChars ?? 0) === (t.gemini?.outputChars ?? 0),
        detail: t.codex?.inputChars === t.gemini?.outputChars
          ? `${t.codex.inputChars} chars passed through correctly`
          : `mismatch: Gemini output=${t.gemini?.outputChars} Codex input=${t.codex?.inputChars}`,
      },
      {
        label: 'Result injected back into Claude',
        ok:    t.finalDecision === 'block',
        detail: t.finalDecision === 'block'
          ? `blocked with ${(t.codex?.outputChars ?? 0)} char result`
          : `unexpected final decision: ${t.finalDecision}`,
      },
    ] : []),

    // Cache check (informational)
    {
      label: 'Cache',
      ok:    true,   // cache hit/miss is neither pass nor fail
      detail: t.cacheHit ? 'hit — result served from cache' : 'miss — pipeline executed',
      warn:  false,
    },

    // Total latency (informational, warn if slow)
    {
      label: 'Total latency',
      ok:    (t.totalLatencyMs ?? 0) < 90000,
      detail: `${t.totalLatencyMs}ms`,
      warn:  t.totalLatencyMs > 30000,
    },
  ]
}

// ── display ───────────────────────────────────────────────────────────────────

function printTrace(t) {
  const time = new Date(t.timestamp).toLocaleTimeString()
  const tool = t.toolName || '(unknown)'
  const files = t.filePaths?.length ?? 0

  console.log()
  console.log(c.bold(`── ${time}  ${tool}  (${files} file(s)) ──────────────────`))

  // Data flow diagram
  const delegated = t.routing?.delegate
  if (delegated === false) {
    console.log(`  Claude ${ARROW} tool call ${ARROW} ${c.green('approve')} ${c.dim('(within token limit, Claude handles directly)')}`)
  } else if (delegated === true) {
    const geminiOk = t.gemini?.called && !t.gemini?.error
    const codexOk  = t.codex?.called  && !t.codex?.fallback
    console.log([
      `  Claude`,
      ARROW,
      `hook`,
      ARROW,
      geminiOk ? c.green('Gemini') : c.red('Gemini✗'),
      ARROW,
      codexOk  ? c.green('Codex')  : c.yellow('Codex(fallback)'),
      ARROW,
      t.finalDecision === 'block' ? c.green('result → Claude') : c.red('failed'),
    ].join(' '))
  } else {
    console.log(`  ${c.dim('(no routing data)')}`)
  }

  console.log()

  // Validation checks
  const results = checks(t)
  let failures = 0
  for (const r of results) {
    const icon = !r.ok ? FAIL : (r.warn ? WARN : PASS)
    if (!r.ok) failures++
    console.log(`  ${icon}  ${r.label.padEnd(40)} ${c.dim(r.detail)}`)
  }

  console.log()
  if (failures === 0) {
    console.log(`  ${c.green('Pipeline ran as described.')}`)
  } else {
    console.log(`  ${c.red(`${failures} check(s) failed — pipeline deviated from spec.`)}`)
  }

  return failures
}

// ── loader ────────────────────────────────────────────────────────────────────

async function loadTraces() {
  let files
  try {
    files = (await readdir(TRACE_DIR))
      .filter(f => f.endsWith('.json'))
      .sort()
      .reverse()
  } catch {
    return []
  }

  if (!ALL) files = files.slice(0, 1)

  const traces = []
  for (const f of files) {
    try {
      const raw = await readFile(join(TRACE_DIR, f), 'utf8')
      traces.push(JSON.parse(raw))
    } catch {
      // skip corrupt trace
    }
  }
  return traces
}

// ── main ──────────────────────────────────────────────────────────────────────

async function run(seenFiles = new Set()) {
  const traces = await loadTraces()

  if (traces.length === 0) {
    console.log(c.dim('\nNo traces found. Use the bridge normally in Claude Code, then run aitools trace.\n'))
    console.log(c.dim(`Trace directory: ${TRACE_DIR}`))
    return
  }

  let totalFailures = 0
  for (const t of traces) {
    const key = t.timestamp
    if (WATCH && seenFiles.has(key)) continue
    seenFiles.add(key)
    totalFailures += printTrace(t)
  }

  if (WATCH && totalFailures === 0 && traces.every(t => seenFiles.has(t.timestamp))) {
    // no new traces yet, print nothing
  }
}

if (WATCH) {
  console.log(c.dim('Watching for new traces… (Ctrl+C to stop)\n'))
  const seen = new Set()
  await run(seen)
  setInterval(() => run(seen), 2000)
} else {
  await run()
}
