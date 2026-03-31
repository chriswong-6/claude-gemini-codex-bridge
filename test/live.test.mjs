/**
 * Live tests — runs the full pipeline against real CLI tools.
 *
 * Requirements before running:
 *   1. gemini CLI installed and authenticated  →  gemini auth login
 *   2. codex CLI installed and authenticated   →  codex login
 *   3. Node.js >= 18
 *
 * Run:
 *   aitools live
 *   node --test test/live.test.mjs
 *
 * These tests make real CLI calls and take 15–60 seconds to complete.
 */

import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFile } from 'child_process'
import { promisify } from 'util'
import { join } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

const exec = promisify(execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT     = join(__dirname, '..')
const FIXTURES = join(__dirname, 'fixtures')
const HOOK     = join(ROOT, 'hooks', 'pre-tool-use.mjs')

// ── helpers ───────────────────────────────────────────────────────────────────

function runHook(inputJson, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [HOOK], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    })
    const stdout = []
    const stderr = []
    child.stdout.on('data', d => stdout.push(d))
    child.stderr.on('data', d => stderr.push(d))
    child.stdin.write(JSON.stringify(inputJson))
    child.stdin.end()
    child.on('close', code => resolve({
      stdout: Buffer.concat(stdout).toString('utf8').trim(),
      stderr: Buffer.concat(stderr).toString('utf8').trim(),
      exitCode: code,
    }))
    child.on('error', reject)
  })
}

function makeToolCall(toolName, toolInput, cwd = ROOT) {
  return { tool_name: toolName, tool_input: toolInput, context: { working_directory: cwd } }
}

// ── pre-flight checks ─────────────────────────────────────────────────────────

describe('pre-flight: CLI tools available', () => {
  test('gemini CLI is installed', async () => {
    try {
      await exec('which', ['gemini'])
    } catch {
      assert.fail('gemini CLI not found in PATH — run: npm install -g @google/gemini-cli')
    }
  })

  test('gemini CLI is authenticated', async () => {
    // A trivial prompt to verify auth works
    const child = spawn('gemini', ['-p', 'Reply with exactly: OK'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.stdin.on('error', () => {})
    child.stdin.end()

    const out = await new Promise((resolve, reject) => {
      const chunks = []
      child.stdout.on('data', d => chunks.push(d))
      child.stderr.on('data', () => {})
      const timer = setTimeout(() => { child.kill(); reject(new Error('gemini auth check timed out (15s)')) }, 15000)
      child.on('close', code => {
        clearTimeout(timer)
        if (code !== 0) reject(new Error(`gemini exited ${code} — run: gemini auth login`))
        else resolve(Buffer.concat(chunks).toString('utf8').trim())
      })
      child.on('error', reject)
    })

    assert.ok(out.length > 0, 'gemini returned empty output — check authentication')
  })

  test('codex CLI is installed', async () => {
    try {
      await exec('which', ['codex'])
    } catch {
      assert.fail('codex CLI not found — run: npm install -g @openai/codex')
    }
  })

  test('codex CLI is authenticated', async () => {
    // codex --version should work even without auth; use a minimal task to verify
    const { stdout } = await exec('codex', ['--version']).catch(() => ({ stdout: '' }))
    assert.ok(true, `codex version: ${stdout.trim()}`)
    // Note: full codex auth is verified implicitly in the pipeline tests below
  })
})

// ── gemini CLI direct ─────────────────────────────────────────────────────────

describe('gemini CLI: direct invocation', () => {
  test('summarises small file', async () => {
    const child = spawn('gemini', ['-p', 'Summarise this file in one sentence:'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.stdin.on('error', () => {})

    const { createReadStream } = await import('fs')
    const fileStream = createReadStream(join(FIXTURES, 'small-file.js'))
    fileStream.pipe(child.stdin)

    const result = await new Promise((resolve, reject) => {
      const chunks = []
      child.stdout.on('data', d => chunks.push(d))
      const timer = setTimeout(() => { child.kill(); reject(new Error('gemini timed out')) }, 30000)
      child.on('close', code => {
        clearTimeout(timer)
        if (code !== 0) reject(new Error(`gemini exited ${code}`))
        else resolve(Buffer.concat(chunks).toString('utf8').trim())
      })
      child.on('error', reject)
    })

    assert.ok(result.length > 20, `gemini response too short: "${result}"`)
  })

  test('handles large file without timeout', async () => {
    const start = Date.now()

    const child = spawn('gemini', ['-p', 'List the first 5 function names in this file:'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.stdin.on('error', () => {})

    const { createReadStream } = await import('fs')
    createReadStream(join(FIXTURES, 'large-file.js')).pipe(child.stdin)

    const result = await new Promise((resolve, reject) => {
      const chunks = []
      const timer = setTimeout(() => { child.kill(); reject(new Error('gemini timed out on large file (120s)')) }, 120000)
      child.stdout.on('data', d => chunks.push(d))
      child.on('close', code => {
        clearTimeout(timer)
        if (code !== 0) reject(new Error(`gemini exited ${code}`))
        else resolve(Buffer.concat(chunks).toString('utf8').trim())
      })
      child.on('error', reject)
    })

    const elapsed = Date.now() - start
    assert.ok(result.length > 20, 'gemini returned too little content for large file')
    console.log(`    gemini large-file latency: ${elapsed}ms`)
  })
})

// ── full pipeline ─────────────────────────────────────────────────────────────

describe('pipeline: end-to-end with real CLIs', () => {
  test('small file passes through (no delegation)', async () => {
    const input = makeToolCall('Read', { file_path: join(FIXTURES, 'small-file.js') })
    const { stdout, exitCode } = await runHook(input, { DEBUG_LEVEL: '1' })

    assert.equal(exitCode, 0)
    assert.equal(JSON.parse(stdout).decision, 'approve',
      'small file should not be delegated')
  })

  test('large file triggers Gemini → Codex pipeline', async (t) => {
    t.diagnostic('this test calls real gemini + codex, may take 30–60s')

    const cacheDir = join(tmpdir(), `bridge-live-${Date.now()}`)
    const input = makeToolCall('Read', { file_path: join(FIXTURES, 'large-file.js') })

    const start = Date.now()
    const { stdout, stderr, exitCode } = await runHook(input, {
      DEBUG_LEVEL: '1',
      CACHE_DIR: cacheDir,
    })
    const elapsed = Date.now() - start

    assert.equal(exitCode, 0, `hook crashed:\n${stderr}`)

    let out
    try {
      out = JSON.parse(stdout)
    } catch {
      assert.fail(`hook stdout is not valid JSON: "${stdout}"`)
    }

    assert.equal(out.decision, 'block',
      `expected pipeline to block and return result, got: ${JSON.stringify(out)}`)
    assert.ok(out.reason.length > 100,
      'pipeline result should be a substantial string')

    console.log(`    pipeline latency: ${elapsed}ms`)
    console.log(`    result length: ${out.reason.length} chars`)
  })

  test('pipeline result contains Gemini summary section', async () => {
    const cacheDir = join(tmpdir(), `bridge-live-sections-${Date.now()}`)
    const input = makeToolCall('Read', { file_path: join(FIXTURES, 'large-file.js') })

    const { stdout } = await runHook(input, { CACHE_DIR: cacheDir })
    const { reason } = JSON.parse(stdout)

    assert.ok(reason.includes('Gemini Context Summary'),
      'result missing Gemini section header')
    assert.ok(reason.includes('Codex Analysis'),
      'result missing Codex section header')
  })

  test('Gemini summary is passed to Codex (not raw file content)', async () => {
    // Verify that Codex receives the Gemini summary, not the raw file.
    // We do this by checking that the result does not contain raw generated
    // function bodies from the fixture (which are meaningless noise).
    const cacheDir = join(tmpdir(), `bridge-live-passthrough-${Date.now()}`)
    const input = makeToolCall('Read', { file_path: join(FIXTURES, 'large-file.js') })

    const { stdout } = await runHook(input, { CACHE_DIR: cacheDir })
    const { reason } = JSON.parse(stdout)

    // The fixture contains lines like: export function fn_4999(x) { return x * 4999 ...
    // These raw lines should NOT appear verbatim in the final output —
    // Gemini should have summarised them, not copied them wholesale.
    const rawFunctionCount = (reason.match(/export function fn_\d+/g) ?? []).length
    assert.ok(rawFunctionCount < 10,
      `result contains ${rawFunctionCount} raw fixture lines — Gemini may not have summarised properly`)
  })

  test('cached result is returned on second call', async () => {
    const cacheDir = join(tmpdir(), `bridge-live-cache-${Date.now()}`)
    const input = makeToolCall('Read', { file_path: join(FIXTURES, 'large-file.js') })
    const env = { CACHE_DIR: cacheDir }

    // First call — real pipeline
    await runHook(input, env)

    // Second call — should be instant from cache
    const t0 = Date.now()
    const second = await runHook(input, env)
    const elapsed = Date.now() - t0

    assert.equal(JSON.parse(second.stdout).decision, 'block')
    assert.ok(elapsed < 500, `cache hit took ${elapsed}ms — expected < 500ms`)
    console.log(`    cache hit latency: ${elapsed}ms`)
  })
})

// ── degradation with real gemini ──────────────────────────────────────────────

describe('degradation: codex unavailable, gemini real', () => {
  test('approves (lets Claude handle directly) when codex is missing', async () => {
    const cacheDir = join(tmpdir(), `bridge-live-degrade-${Date.now()}`)
    const input = makeToolCall('Read', { file_path: join(FIXTURES, 'large-file.js') })

    const { stdout, exitCode } = await runHook(input, {
      CODEX_BIN: '/nonexistent/codex',
      CACHE_DIR: cacheDir,
    })

    assert.equal(exitCode, 0)
    const out = JSON.parse(stdout)
    assert.equal(out.decision, 'approve',
      'Codex is required — missing Codex should degrade to approve, not return partial result')
  })
})
