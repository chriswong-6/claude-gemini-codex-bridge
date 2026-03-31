/**
 * Integration tests — verifies the full Gemini → Codex pipeline workflow.
 *
 * All external calls are MOCKED via stub binaries — no API keys, no auth needed.
 * Set BRIDGE_TEST_LIVE=true to run against real gemini CLI + Codex.
 *
 * Run:  node --test test/integration.test.mjs
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'child_process'
import { writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT      = join(__dirname, '..')
const FIXTURES  = join(__dirname, 'fixtures')
const HOOK      = join(ROOT, 'hooks', 'pre-tool-use.mjs')
const LIVE      = process.env.BRIDGE_TEST_LIVE === 'true'

const MOCK_GEMINI_RESPONSE = 'GEMINI_MOCK_SUMMARY: key functions found in large-file.js'
const MOCK_CODEX_RESPONSE  = 'CODEX_MOCK_ANALYSIS: no issues found in the summarised code'

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

function makeToolCall(toolName, toolInput, cwd = '/tmp') {
  return { tool_name: toolName, tool_input: toolInput, context: { working_directory: cwd } }
}

/**
 * Create a stub binary that writes a fixed string to stdout and exits 0.
 * Supports the -o <file> flag used by codex exec to write last message to a file.
 */
async function createStubBin(dir, name, output) {
  await mkdir(dir, { recursive: true })
  const p = join(dir, name)
  await writeFile(p, `#!/usr/bin/env node
import { writeFileSync } from 'fs'
const args = process.argv.slice(2)
const oIdx = args.indexOf('-o')
if (oIdx !== -1 && args[oIdx + 1]) {
  writeFileSync(args[oIdx + 1], ${JSON.stringify(output + '\n')})
} else {
  process.stdout.write(${JSON.stringify(output + '\n')})
}
`, { mode: 0o755 })
  return p
}

// ── shared stub paths ─────────────────────────────────────────────────────────

let stubGeminiBin
let stubCodexBin

before(async () => {
  const dir = join(tmpdir(), `bridge-stubs-${Date.now()}`)
  stubGeminiBin = await createStubBin(dir, 'gemini', MOCK_GEMINI_RESPONSE)
  stubCodexBin  = await createStubBin(dir, 'codex',  MOCK_CODEX_RESPONSE)
})

// ── workflow tests ────────────────────────────────────────────────────────────

describe('workflow: small file → approve (pass-through)', () => {
  test('hook outputs {"decision":"approve"} for small file', async () => {
    const input = makeToolCall('Read', { file_path: join(FIXTURES, 'small-file.js') })
    const { stdout, exitCode } = await runHook(input)
    assert.equal(exitCode, 0)
    assert.equal(JSON.parse(stdout).decision, 'approve')
  })

  test('hook outputs approve for unknown tool (Write)', async () => {
    const input = makeToolCall('Write', { file_path: '/tmp/foo.txt', content: 'x' })
    const { stdout } = await runHook(input)
    assert.equal(JSON.parse(stdout).decision, 'approve')
  })

  test('hook outputs approve for empty stdin', async () => {
    const child = spawn('node', [HOOK], { stdio: ['pipe', 'pipe', 'pipe'] })
    const stdout = []
    child.stdout.on('data', d => stdout.push(d))
    child.stdin.end()
    await new Promise(r => child.on('close', r))
    assert.equal(JSON.parse(Buffer.concat(stdout).toString().trim()).decision, 'approve')
  })
})

describe('workflow: large file → Gemini → Codex → block with result', () => {
  test('hook delegates large file and returns pipeline output', async (t) => {
    if (LIVE) { t.skip('use mock mode for pipeline output tests'); return }

    const input = makeToolCall('Read', { file_path: join(FIXTURES, 'large-file.js') })
    const env = { GEMINI_BIN: stubGeminiBin, CODEX_BIN: stubCodexBin }

    const { stdout, exitCode } = await runHook(input, env)
    assert.equal(exitCode, 0, 'hook should exit 0')

    const out = JSON.parse(stdout)
    assert.equal(out.decision, 'block', `expected block, got: ${JSON.stringify(out)}`)
    assert.ok(typeof out.reason === 'string' && out.reason.length > 0)
  })

  test('pipeline result contains both Gemini and Codex sections', async (t) => {
    if (LIVE) { t.skip('format check is mock-only'); return }

    const input = makeToolCall('Read', { file_path: join(FIXTURES, 'large-file.js') })
    const env = {
      GEMINI_BIN: stubGeminiBin,
      CODEX_BIN:  stubCodexBin,
      CACHE_DIR:  join(tmpdir(), `bridge-sections-${Date.now()}`),
    }

    const { stdout } = await runHook(input, env)
    const { reason } = JSON.parse(stdout)

    assert.ok(reason.includes('Gemini Context Summary'), 'missing Gemini section')
    assert.ok(reason.includes('Codex Analysis'),         'missing Codex section')
    assert.ok(reason.includes(MOCK_GEMINI_RESPONSE),     'missing Gemini mock output')
    assert.ok(reason.includes(MOCK_CODEX_RESPONSE),      'missing Codex mock output')
  })

  test('Gemini section appears before Codex section (sequential ordering)', async (t) => {
    if (LIVE) { t.skip('ordering check is mock-only'); return }

    const input = makeToolCall('Read', { file_path: join(FIXTURES, 'large-file.js') })
    const env = {
      GEMINI_BIN: stubGeminiBin,
      CODEX_BIN:  stubCodexBin,
      CACHE_DIR:  join(tmpdir(), `bridge-order-${Date.now()}`),
    }

    const { stdout } = await runHook(input, env)
    const { reason } = JSON.parse(stdout)

    assert.ok(
      reason.indexOf('Gemini Context Summary') < reason.indexOf('Codex Analysis'),
      'Gemini section must come before Codex section'
    )
  })
})

describe('workflow: caching', () => {
  test('second call returns cached result (fast)', async (t) => {
    if (LIVE) { t.skip('caching test is mock-only'); return }

    const cacheDir = join(tmpdir(), `bridge-cache-integ-${Date.now()}`)
    const input = makeToolCall('Read', { file_path: join(FIXTURES, 'large-file.js') })
    const env = { GEMINI_BIN: stubGeminiBin, CODEX_BIN: stubCodexBin, CACHE_DIR: cacheDir }

    // First call — populates cache
    const first = await runHook(input, env)
    assert.equal(JSON.parse(first.stdout).decision, 'block')

    // Second call — should hit cache
    const t0 = Date.now()
    const second = await runHook(input, env)
    const elapsed = Date.now() - t0

    assert.equal(JSON.parse(second.stdout).decision, 'block')
    assert.ok(elapsed < 500, `cache hit took ${elapsed}ms — expected < 500ms`)
  })
})

describe('workflow: graceful degradation', () => {
  test('Codex unavailable → approve (pipeline incomplete, let Claude handle it)', async (t) => {
    if (LIVE) { t.skip('degradation test is mock-only'); return }

    const input = makeToolCall('Read', { file_path: join(FIXTURES, 'large-file.js') })
    const env = {
      GEMINI_BIN: stubGeminiBin,
      CODEX_BIN:  '/nonexistent/codex-binary',
      CACHE_DIR:  join(tmpdir(), `bridge-degrade-${Date.now()}`),
    }

    const { stdout, exitCode } = await runHook(input, env)
    assert.equal(exitCode, 0)

    const out = JSON.parse(stdout)
    assert.equal(out.decision, 'approve',
      'Codex is required — missing Codex should degrade to approve, not return partial result')
  })

  test('Gemini CLI missing → approve (let Claude handle it)', async (t) => {
    if (LIVE) { t.skip('degradation test is mock-only'); return }

    const input = makeToolCall('Read', { file_path: join(FIXTURES, 'large-file.js') })
    const env = {
      GEMINI_BIN: '/nonexistent/gemini-binary',
      CACHE_DIR:  join(tmpdir(), `bridge-nogemini-${Date.now()}`),
    }

    const { stdout, exitCode } = await runHook(input, env)
    assert.equal(exitCode, 0)
    assert.equal(JSON.parse(stdout).decision, 'approve',
      'missing gemini CLI should degrade to approve, not crash')
  })
})
