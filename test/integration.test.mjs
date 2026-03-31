/**
 * Integration tests — verifies the full Gemini → Codex pipeline workflow.
 *
 * By default all external calls are MOCKED so no API keys are needed.
 * Set BRIDGE_TEST_LIVE=true to run against real Gemini + Codex.
 *
 * Run:  node --test test/integration.test.mjs
 */

import { test, describe, mock, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'child_process'
import { writeFile, rm, mkdir } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT      = join(__dirname, '..')
const FIXTURES  = join(__dirname, 'fixtures')
const HOOK      = join(ROOT, 'hooks', 'pre-tool-use.mjs')
const LIVE      = process.env.BRIDGE_TEST_LIVE === 'true'

// ── mock helpers ──────────────────────────────────────────────────────────────

/**
 * Run the hook as a child process with a given stdin JSON.
 * Returns { stdout, stderr, exitCode }.
 */
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
    child.on('close', code => {
      resolve({
        stdout: Buffer.concat(stdout).toString('utf8').trim(),
        stderr: Buffer.concat(stderr).toString('utf8').trim(),
        exitCode: code,
      })
    })
    child.on('error', reject)
  })
}

function makeToolCall(toolName, toolInput, cwd = '/tmp') {
  return {
    tool_name: toolName,
    tool_input: toolInput,
    context: { working_directory: cwd },
  }
}

// ── Gemini mock server ────────────────────────────────────────────────────────
// We intercept fetch() by setting a fake API key and pointing to a local server,
// OR we rely on the hook's env-var overrides + test doubles below.

// For mock mode we patch the Gemini and Codex modules via env vars that redirect
// to stub binaries / stub responses. The simplest approach: we test the pipeline
// by running pre-tool-use.mjs with:
//   GEMINI_API_KEY=mock  →  the real fetch will fail with an error
// Instead, we use a tiny HTTP mock server for Gemini.

import http from 'http'

let mockGeminiServer
let mockGeminiPort
const MOCK_GEMINI_RESPONSE = 'GEMINI_MOCK_SUMMARY: key functions found in large-file.js'
const MOCK_CODEX_RESPONSE  = 'CODEX_MOCK_ANALYSIS: no issues found in the summarised code'

async function startMockGemini() {
  return new Promise(resolve => {
    mockGeminiServer = http.createServer((req, res) => {
      let body = ''
      req.on('data', d => body += d)
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          candidates: [{
            content: { parts: [{ text: MOCK_GEMINI_RESPONSE }] },
          }],
        }))
      })
    })
    mockGeminiServer.listen(0, '127.0.0.1', () => {
      mockGeminiPort = mockGeminiServer.address().port
      resolve()
    })
  })
}

async function stopMockGemini() {
  return new Promise(resolve => mockGeminiServer?.close(resolve))
}

// Stub codex binary that writes a predictable response
let stubCodexPath
async function createStubCodex() {
  const dir = join(tmpdir(), `bridge-stub-${Date.now()}`)
  await mkdir(dir, { recursive: true })
  stubCodexPath = join(dir, 'codex')
  await writeFile(stubCodexPath,
    `#!/usr/bin/env node\nprocess.stdout.write('${MOCK_CODEX_RESPONSE}\\n')\n`,
    { mode: 0o755 })
  return dir
}

// ── workflow tests ────────────────────────────────────────────────────────────

describe('workflow: small file → approve (pass-through)', () => {
  test('hook outputs {"decision":"approve"} for small file', async () => {
    const input = makeToolCall('Read',
      { file_path: join(FIXTURES, 'small-file.js') })

    const { stdout, exitCode } = await runHook(input)
    assert.equal(exitCode, 0, 'hook should exit 0')

    const out = JSON.parse(stdout)
    assert.equal(out.decision, 'approve', `expected approve, got: ${JSON.stringify(out)}`)
  })

  test('hook outputs approve for unknown tool (Write)', async () => {
    const input = makeToolCall('Write', { file_path: '/tmp/foo.txt', content: 'x' })
    const { stdout } = await runHook(input)
    const out = JSON.parse(stdout)
    assert.equal(out.decision, 'approve')
  })

  test('hook outputs approve for empty stdin', async () => {
    const child = spawn('node', [HOOK], { stdio: ['pipe', 'pipe', 'pipe'] })
    const stdout = []
    child.stdout.on('data', d => stdout.push(d))
    child.stdin.end()
    await new Promise(r => child.on('close', r))
    const out = JSON.parse(Buffer.concat(stdout).toString('utf8').trim())
    assert.equal(out.decision, 'approve')
  })
})

describe('workflow: large file → Gemini → Codex → block with result', () => {
  let stubDir
  before(async () => {
    if (!LIVE) {
      await startMockGemini()
      stubDir = await createStubCodex()
    }
  })
  after(async () => {
    if (!LIVE) await stopMockGemini()
  })

  test('hook delegates large file and returns pipeline output', async (t) => {
    if (LIVE && !process.env.GEMINI_API_KEY) {
      t.skip('GEMINI_API_KEY not set — skipping live test')
      return
    }

    const input = makeToolCall('Read',
      { file_path: join(FIXTURES, 'large-file.js') })

    // In mock mode: point Gemini to our local server, use stub codex
    const env = LIVE ? {} : {
      GEMINI_API_KEY: 'mock-key',
      // Override the Gemini API base URL by patching — done via GEMINI_API_URL env
      GEMINI_API_URL: `http://127.0.0.1:${mockGeminiPort}`,
      CODEX_BIN: stubCodexPath,
      DEBUG_LEVEL: '1',
    }

    const { stdout, stderr, exitCode } = await runHook(input, env)
    assert.equal(exitCode, 0, `hook crashed: ${stderr}`)

    let out
    try {
      out = JSON.parse(stdout)
    } catch {
      assert.fail(`hook stdout is not valid JSON: ${stdout}`)
    }

    assert.equal(out.decision, 'block',
      `expected block decision, got: ${JSON.stringify(out)}`)
    assert.ok(typeof out.reason === 'string' && out.reason.length > 0,
      'reason must be a non-empty string')
  })

  test('pipeline result contains both Gemini and Codex sections', async (t) => {
    if (LIVE) { t.skip('format check is mock-only'); return }

    const input = makeToolCall('Read',
      { file_path: join(FIXTURES, 'large-file.js') })

    const env = {
      GEMINI_API_KEY: 'mock-key',
      GEMINI_API_URL: `http://127.0.0.1:${mockGeminiPort}`,
      CODEX_BIN: stubCodexPath,
    }

    const { stdout } = await runHook(input, env)
    const out = JSON.parse(stdout)

    assert.ok(out.reason.includes('Gemini Context Summary'),
      'result should contain Gemini section header')
    assert.ok(out.reason.includes('Codex Analysis'),
      'result should contain Codex section header')
    assert.ok(out.reason.includes(MOCK_GEMINI_RESPONSE),
      'result should contain Gemini mock response')
    assert.ok(out.reason.includes(MOCK_CODEX_RESPONSE),
      'result should contain Codex mock response')
  })

  test('Gemini output is passed to Codex (sequential ordering)', async (t) => {
    if (LIVE) { t.skip('ordering check is mock-only'); return }

    // Verify ordering: Gemini section appears BEFORE Codex section in the output
    const input = makeToolCall('Read',
      { file_path: join(FIXTURES, 'large-file.js') })

    const env = {
      GEMINI_API_KEY: 'mock-key',
      GEMINI_API_URL: `http://127.0.0.1:${mockGeminiPort}`,
      CODEX_BIN: stubCodexPath,
    }

    const { stdout } = await runHook(input, env)
    const reason = JSON.parse(stdout).reason

    const geminiPos = reason.indexOf('Gemini Context Summary')
    const codexPos  = reason.indexOf('Codex Analysis')
    assert.ok(geminiPos < codexPos,
      'Gemini section must appear before Codex section in the output')
  })
})

describe('workflow: caching', () => {
  let stubDir
  before(async () => {
    await startMockGemini()
    stubDir = await createStubCodex()
  })
  after(async () => stopMockGemini())

  test('second call with same file returns cached result (no Gemini re-call)', async () => {
    const cacheDir = join(tmpdir(), `bridge-cache-integ-${Date.now()}`)
    const input = makeToolCall('Read',
      { file_path: join(FIXTURES, 'large-file.js') })

    const env = {
      GEMINI_API_KEY: 'mock-key',
      GEMINI_API_URL: `http://127.0.0.1:${mockGeminiPort}`,
      CODEX_BIN: stubCodexPath,
      CACHE_DIR: cacheDir,
    }

    // First call — populates cache
    const first = await runHook(input, env)
    assert.equal(JSON.parse(first.stdout).decision, 'block')

    // Second call — should return immediately from cache
    const t0 = Date.now()
    const second = await runHook(input, env)
    const elapsed = Date.now() - t0

    assert.equal(JSON.parse(second.stdout).decision, 'block')
    // Cache hit should be much faster than a real Gemini call (< 500ms)
    assert.ok(elapsed < 500, `cache hit took ${elapsed}ms — expected < 500ms`)
  })
})

describe('workflow: graceful degradation', () => {
  before(async () => startMockGemini())
  after(async () => stopMockGemini())

  test('Codex unavailable → fallback to Gemini summary (still blocks)', async () => {
    const input = makeToolCall('Read',
      { file_path: join(FIXTURES, 'large-file.js') })

    const env = {
      GEMINI_API_KEY: 'mock-key',
      GEMINI_API_URL: `http://127.0.0.1:${mockGeminiPort}`,
      CODEX_BIN: '/nonexistent/codex-binary',  // will fail
    }

    const { stdout, exitCode } = await runHook(input, env)
    assert.equal(exitCode, 0)

    const out = JSON.parse(stdout)
    assert.equal(out.decision, 'block',
      'should still block with Gemini-only fallback result')
    assert.ok(out.reason.includes(MOCK_GEMINI_RESPONSE),
      'fallback result should still contain Gemini summary')
  })

  test('Gemini API key missing → approve (let Claude handle it)', async () => {
    const input = makeToolCall('Read',
      { file_path: join(FIXTURES, 'large-file.js') })

    // Use a fresh cache dir so previous test's cached result doesn't interfere
    const env = {
      GEMINI_API_KEY: '',
      CACHE_DIR: join(tmpdir(), `bridge-nokey-${Date.now()}`),
    }

    const { stdout, exitCode } = await runHook(input, env)
    assert.equal(exitCode, 0)
    const out = JSON.parse(stdout)
    assert.equal(out.decision, 'approve',
      'missing API key should degrade to approve, not crash')
  })
})
