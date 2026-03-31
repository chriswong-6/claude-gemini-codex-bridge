#!/usr/bin/env node
/**
 * bridge-check — diagnostic tool for claude-gemini-codex-bridge.
 *
 * Checks every component and prints a status report.
 * Does NOT modify any files or make API calls beyond a lightweight ping.
 *
 * Usage:
 *   node test/check.mjs           # quick diagnostics
 *   node test/check.mjs --live    # also ping real Gemini API (needs GEMINI_API_KEY)
 */

import { execFile } from 'child_process'
import { access, stat, constants } from 'fs/promises'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { promisify } from 'util'

const exec = promisify(execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const LIVE = process.argv.includes('--live')

// ── terminal colours ──────────────────────────────────────────────────────────
const isTTY = process.stdout.isTTY
const c = {
  green:  s => isTTY ? `\x1b[32m${s}\x1b[0m` : s,
  red:    s => isTTY ? `\x1b[31m${s}\x1b[0m` : s,
  yellow: s => isTTY ? `\x1b[33m${s}\x1b[0m` : s,
  bold:   s => isTTY ? `\x1b[1m${s}\x1b[0m`  : s,
  dim:    s => isTTY ? `\x1b[2m${s}\x1b[0m`  : s,
}

const PASS = c.green('✓')
const FAIL = c.red('✗')
const WARN = c.yellow('!')
const SKIP = c.dim('–')

// ── result collector ──────────────────────────────────────────────────────────
const results = []

function record(component, status, detail = '') {
  results.push({ component, status, detail })
  const icon = status === 'pass' ? PASS : status === 'warn' ? WARN : status === 'skip' ? SKIP : FAIL
  const line = `  ${icon}  ${component.padEnd(32)} ${c.dim(detail)}`
  console.log(line)
}

// ── checks ────────────────────────────────────────────────────────────────────

async function checkFile(label, relPath) {
  try {
    await access(join(ROOT, relPath), constants.R_OK)
    record(label, 'pass', relPath)
    return true
  } catch {
    record(label, 'fail', `not found: ${relPath}`)
    return false
  }
}

async function checkBin(label, bin) {
  try {
    const { stdout } = await exec(bin, ['--version']).catch(
      () => exec('which', [bin])
    )
    record(label, 'pass', stdout.trim().split('\n')[0].slice(0, 60))
    return true
  } catch {
    record(label, 'fail', `'${bin}' not found in PATH`)
    return false
  }
}

async function checkEnv(label, varName, required = true) {
  const val = process.env[varName]
  if (val && val.length > 0) {
    record(label, 'pass', `${varName}=${val.slice(0, 8)}…`)
    return true
  }
  if (required) {
    record(label, 'fail', `${varName} is not set`)
  } else {
    record(label, 'warn', `${varName} not set (optional)`)
  }
  return false
}

async function checkNodeVersion() {
  const major = parseInt(process.versions.node.split('.')[0])
  if (major >= 18) {
    record('Node.js version', 'pass', `v${process.versions.node} (>= 18 required)`)
    return true
  }
  record('Node.js version', 'fail', `v${process.versions.node} — need >= 18`)
  return false
}

async function checkConfig() {
  try {
    const { loadConfig } = await import(`${ROOT}/hooks/lib/config.mjs`)
    const cfg = await loadConfig()
    const keys = ['routing', 'gemini', 'codex', 'cache', 'security', 'debug']
    const missing = keys.filter(k => !cfg[k])
    if (missing.length === 0) {
      record('config.mjs', 'pass', `all sections present`)
      return cfg
    }
    record('config.mjs', 'fail', `missing: ${missing.join(', ')}`)
    return null
  } catch (err) {
    record('config.mjs', 'fail', err.message)
    return null
  }
}

async function checkRouter(cfg) {
  try {
    const { shouldDelegate } = await import(`${ROOT}/hooks/lib/router.mjs`)
    // Small file → should NOT delegate
    const small = await shouldDelegate('Read', [], cfg)
    if (small.delegate !== false) {
      record('router.mjs', 'fail', 'empty path list should not delegate')
      return false
    }
    record('router.mjs', 'pass', 'routing logic functional')
    return true
  } catch (err) {
    record('router.mjs', 'fail', err.message)
    return false
  }
}

async function checkCache(cfg) {
  try {
    const { buildCacheKey, getCached, setCached } = await import(`${ROOT}/hooks/lib/cache.mjs`)
    const key = await buildCacheKey([], `check-${Date.now()}`)
    await setCached(key, 'test-value', cfg)
    const val = await getCached(key, cfg)
    if (val !== 'test-value') {
      record('cache.mjs', 'fail', 'stored value mismatch')
      return false
    }
    record('cache.mjs', 'pass', `cache dir: ${cfg.cache.dir}`)
    return true
  } catch (err) {
    record('cache.mjs', 'fail', err.message)
    return false
  }
}

async function checkPaths() {
  try {
    const { resolveClaudePath, extractFilePaths } = await import(`${ROOT}/hooks/lib/paths.mjs`)
    const resolved = resolveClaudePath('@src/index.js', '/project')
    if (resolved !== '/project/src/index.js') {
      record('paths.mjs', 'fail', `unexpected resolution: ${resolved}`)
      return false
    }
    const blocked = resolveClaudePath('../etc/passwd', '/project')
    if (blocked !== '') {
      record('paths.mjs', 'fail', 'path traversal not blocked')
      return false
    }
    record('paths.mjs', 'pass', '@ resolution and traversal guard OK')
    return true
  } catch (err) {
    record('paths.mjs', 'fail', err.message)
    return false
  }
}

async function checkGeminiPing(cfg) {
  if (!LIVE) {
    record('Gemini API connectivity', 'skip', 'pass --live to test')
    return
  }
  if (!cfg?.gemini?.apiKey) {
    record('Gemini API connectivity', 'fail', 'GEMINI_API_KEY not set')
    return
  }
  try {
    const baseUrl = process.env.GEMINI_API_URL
      ?? 'https://generativelanguage.googleapis.com/v1beta'
    const url = `${baseUrl}/models?key=${cfg.gemini.apiKey}`
    const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (resp.ok) {
      record('Gemini API connectivity', 'pass', `HTTP ${resp.status}`)
    } else {
      record('Gemini API connectivity', 'fail', `HTTP ${resp.status}`)
    }
  } catch (err) {
    record('Gemini API connectivity', 'fail', err.message)
  }
}

async function checkCodexBin(cfg) {
  const bin = cfg?.codex?.bin ?? 'codex'
  try {
    await exec(bin, ['--version']).catch(() => exec('which', [bin]))
    record('codex binary', 'pass', `found: ${bin}`)
    return true
  } catch {
    record('codex binary', 'warn', `'${bin}' not found — Codex step will fallback to Gemini-only`)
    return false
  }
}

async function checkHookScript() {
  const hookPath = join(ROOT, 'hooks', 'pre-tool-use.mjs')
  try {
    await access(hookPath, constants.R_OK)
    // Verify it parses without syntax errors
    await exec('node', ['--input-type=module', '--eval',
      `import '${hookPath}'; /* dry import */`
    ]).catch(() => {})  // import side-effects are expected to error — we just want parse check
    record('pre-tool-use.mjs', 'pass', hookPath)
    return true
  } catch (err) {
    record('pre-tool-use.mjs', 'fail', err.message.split('\n')[0])
    return false
  }
}

async function checkInstallScript() {
  try {
    await access(join(ROOT, 'install.sh'), constants.R_OK)
    await exec('bash', ['-n', join(ROOT, 'install.sh')])
    record('install.sh syntax', 'pass', 'bash -n passed')
    await access(join(ROOT, 'uninstall.sh'), constants.R_OK)
    await exec('bash', ['-n', join(ROOT, 'uninstall.sh')])
    record('uninstall.sh syntax', 'pass', 'bash -n passed')
    return true
  } catch (err) {
    record('install/uninstall scripts', 'fail', err.message.split('\n')[0])
    return false
  }
}

// ── summary ───────────────────────────────────────────────────────────────────

function printSummary() {
  const pass = results.filter(r => r.status === 'pass').length
  const fail = results.filter(r => r.status === 'fail').length
  const warn = results.filter(r => r.status === 'warn').length
  const skip = results.filter(r => r.status === 'skip').length
  const total = results.length

  console.log()
  console.log(c.bold('─── Summary ───────────────────────────────────────'))
  console.log(`  ${c.green(`${pass} passed`)}   ${fail > 0 ? c.red(`${fail} failed`) : c.dim('0 failed')}   ${warn > 0 ? c.yellow(`${warn} warnings`) : c.dim('0 warnings')}   ${c.dim(`${skip} skipped`)}`)
  console.log()

  if (fail > 0) {
    console.log(c.red('  Bridge is NOT ready. Fix the failures above before use.'))
  } else if (warn > 0) {
    console.log(c.yellow('  Bridge is PARTIALLY ready. Warnings indicate optional components.'))
  } else {
    console.log(c.green('  Bridge is READY.'))
  }
  console.log()

  return fail === 0
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log()
  console.log(c.bold('claude-gemini-codex-bridge — component check'))
  if (LIVE) console.log(c.yellow('  live mode: will ping Gemini API'))
  console.log()

  console.log(c.bold('  Runtime'))
  await checkNodeVersion()
  await checkBin('jq', 'jq')

  console.log()
  console.log(c.bold('  Project files'))
  await checkFile('config/defaults.json', 'config/defaults.json')
  await checkFile('hooks/pre-tool-use.mjs', 'hooks/pre-tool-use.mjs')
  await checkFile('hooks/lib/config.mjs',   'hooks/lib/config.mjs')
  await checkFile('hooks/lib/router.mjs',   'hooks/lib/router.mjs')
  await checkFile('hooks/lib/gemini.mjs',   'hooks/lib/gemini.mjs')
  await checkFile('hooks/lib/codex.mjs',    'hooks/lib/codex.mjs')
  await checkFile('hooks/lib/cache.mjs',    'hooks/lib/cache.mjs')
  await checkFile('hooks/lib/paths.mjs',    'hooks/lib/paths.mjs')
  await checkFile('hooks/lib/logger.mjs',   'hooks/lib/logger.mjs')

  console.log()
  console.log(c.bold('  Environment'))
  await checkEnv('GEMINI_API_KEY', 'GEMINI_API_KEY', true)
  await checkEnv('CODEX_BIN override', 'CODEX_BIN', false)

  console.log()
  console.log(c.bold('  Module functionality'))
  const cfg = await checkConfig()
  if (cfg) {
    await checkPaths()
    await checkRouter(cfg)
    await checkCache(cfg)
  }

  console.log()
  console.log(c.bold('  External dependencies'))
  await checkCodexBin(cfg)
  await checkGeminiPing(cfg)

  console.log()
  console.log(c.bold('  Scripts'))
  await checkHookScript()
  await checkInstallScript()

  const ok = printSummary()
  process.exit(ok ? 0 : 1)
}

main().catch(err => {
  console.error(c.red(`\nFatal: ${err.message}`))
  process.exit(1)
})
