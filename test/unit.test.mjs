/**
 * Unit tests — each component in isolation, no external API calls.
 *
 * Run:  node --test test/unit.test.mjs
 */

import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT      = join(__dirname, '..')
const FIXTURES  = join(__dirname, 'fixtures')

// ── config ────────────────────────────────────────────────────────────────────

describe('config', () => {
  test('loads without error and has all required keys', async () => {
    const { loadConfig } = await import(`${ROOT}/hooks/lib/config.mjs`)
    const cfg = await loadConfig()
    assert.ok(cfg.routing,  'routing section missing')
    assert.ok(cfg.gemini,   'gemini section missing')
    assert.ok(cfg.codex,    'codex section missing')
    assert.ok(cfg.cache,    'cache section missing')
    assert.ok(cfg.security, 'security section missing')
    assert.ok(cfg.debug,    'debug section missing')
  })

  test('routing thresholds are positive integers', async () => {
    const { loadConfig } = await import(`${ROOT}/hooks/lib/config.mjs`)
    const { routing } = await loadConfig()
    assert.ok(routing.claudeTokenLimit > 0,  'claudeTokenLimit must be > 0')
    assert.ok(routing.geminiTokenLimit > routing.claudeTokenLimit,
      'geminiTokenLimit must exceed claudeTokenLimit')
    assert.ok(routing.maxTotalSizeBytes > 0, 'maxTotalSizeBytes must be > 0')
    assert.ok(routing.charsPerToken > 0,     'charsPerToken must be > 0')
  })

  test('security excludePatterns is a non-empty array', async () => {
    const { loadConfig } = await import(`${ROOT}/hooks/lib/config.mjs`)
    const { security } = await loadConfig()
    assert.ok(Array.isArray(security.excludePatterns), 'excludePatterns must be an array')
    assert.ok(security.excludePatterns.length > 0,     'excludePatterns must not be empty')
  })
})

// ── logger ────────────────────────────────────────────────────────────────────

describe('logger', () => {
  test('initLogger + log does not throw', async () => {
    const { initLogger, log, logError } = await import(`${ROOT}/hooks/lib/logger.mjs`)
    assert.doesNotThrow(() => initLogger(0, null))
    assert.doesNotThrow(() => log(1, 'test message'))
    assert.doesNotThrow(() => logError('test error'))
  })

  test('writes to log file when logDir is set without crashing', async () => {
    const { initLogger, log } = await import(`${ROOT}/hooks/lib/logger.mjs`)
    const dir = join(tmpdir(), `bridge-logger-test-${Date.now()}`)
    initLogger(2, dir)
    log(1, 'hello from test')
    await new Promise(r => setTimeout(r, 60))
    initLogger(0, null)
  })
})

// ── paths ─────────────────────────────────────────────────────────────────────

describe('paths', () => {
  test('resolves @src/foo.js to absolute path', async () => {
    const { resolveClaudePath } = await import(`${ROOT}/hooks/lib/paths.mjs`)
    assert.equal(
      resolveClaudePath('@src/foo.js', '/home/user/project'),
      '/home/user/project/src/foo.js'
    )
  })

  test('resolves @/ to project root', async () => {
    const { resolveClaudePath } = await import(`${ROOT}/hooks/lib/paths.mjs`)
    const result = resolveClaudePath('@/', '/home/user/project')
    assert.ok(result.startsWith('/home/user/project'))
  })

  test('blocks path traversal attempts', async () => {
    const { resolveClaudePath } = await import(`${ROOT}/hooks/lib/paths.mjs`)
    assert.equal(resolveClaudePath('../etc/passwd', '/project'), '')
    assert.equal(resolveClaudePath('@../../secret', '/project'), '')
  })

  test('extracts file path from Read tool input', async () => {
    const { extractFilePaths } = await import(`${ROOT}/hooks/lib/paths.mjs`)
    const paths = extractFilePaths('Read', { file_path: '@src/index.js' }, '/project')
    assert.equal(paths.length, 1)
    assert.ok(paths[0].endsWith('src/index.js'))
  })

  test('extracts search root from Grep tool input', async () => {
    const { extractFilePaths } = await import(`${ROOT}/hooks/lib/paths.mjs`)
    const paths = extractFilePaths('Grep', { pattern: 'TODO', path: '@src' }, '/project')
    assert.equal(paths.length, 1)
    assert.ok(paths[0].endsWith('/src'))
  })

  test('extracts @ paths from Task prompt', async () => {
    const { extractFilePaths } = await import(`${ROOT}/hooks/lib/paths.mjs`)
    const paths = extractFilePaths('Task',
      { prompt: 'Review @src/auth.js and @src/db.js' }, '/project')
    assert.equal(paths.length, 2)
  })

  test('returns empty array for unsupported tool', async () => {
    const { extractFilePaths } = await import(`${ROOT}/hooks/lib/paths.mjs`)
    assert.deepEqual(extractFilePaths('Write', {}, '/project'), [])
  })

  test('describeToolCall produces non-empty string', async () => {
    const { describeToolCall } = await import(`${ROOT}/hooks/lib/paths.mjs`)
    assert.ok(describeToolCall('Read', { file_path: 'foo.js' }).length > 0)
    assert.ok(describeToolCall('Grep', { pattern: 'fn', path: '.' }).length > 0)
    assert.ok(describeToolCall('Task', { prompt: 'do it' }).length > 0)
  })
})

// ── router ────────────────────────────────────────────────────────────────────

describe('router', () => {
  const cfg = {
    routing: {
      claudeTokenLimit:  50000,
      geminiTokenLimit:  800000,
      maxTotalSizeBytes: 10_485_760,
      minFilesForTask:   3,
      charsPerToken:     4,
    },
    security: {
      excludePatterns: ['*.secret', '*.key', '.env*'],
      blockedPaths:    ['/etc/', '/usr/'],
    },
  }

  test('small file → approve (no delegation)', async () => {
    const { shouldDelegate } = await import(`${ROOT}/hooks/lib/router.mjs`)
    const { delegate } = await shouldDelegate(
      'Read', [join(FIXTURES, 'small-file.js')], cfg)
    assert.equal(delegate, false)
  })

  test('large file → delegate', async () => {
    const { shouldDelegate } = await import(`${ROOT}/hooks/lib/router.mjs`)
    const { delegate, reason } = await shouldDelegate(
      'Read', [join(FIXTURES, 'large-file.js')], cfg)
    assert.equal(delegate, true, `expected delegation, got: ${reason}`)
  })

  test('unsupported tool (Write) → approve', async () => {
    const { shouldDelegate } = await import(`${ROOT}/hooks/lib/router.mjs`)
    const { delegate } = await shouldDelegate('Write', [], cfg)
    assert.equal(delegate, false)
  })

  test('blocked path /etc/passwd → approve (security)', async () => {
    const { shouldDelegate } = await import(`${ROOT}/hooks/lib/router.mjs`)
    const { delegate } = await shouldDelegate('Read', ['/etc/passwd'], cfg)
    assert.equal(delegate, false)
  })

  test('excluded pattern .env.production → approve', async () => {
    const { shouldDelegate } = await import(`${ROOT}/hooks/lib/router.mjs`)
    const { delegate } = await shouldDelegate(
      'Read', [join(FIXTURES, '.env.production')], cfg)
    assert.equal(delegate, false)
  })

  test('empty file list → approve', async () => {
    const { shouldDelegate } = await import(`${ROOT}/hooks/lib/router.mjs`)
    const { delegate } = await shouldDelegate('Read', [], cfg)
    assert.equal(delegate, false)
  })
})

// ── cache ─────────────────────────────────────────────────────────────────────

describe('cache', () => {
  const CACHE_DIR = join(tmpdir(), `bridge-cache-test-${Date.now()}`)
  const cfg = { cache: { dir: CACHE_DIR, ttlSeconds: 60 } }

  test('buildCacheKey returns 64-char hex string', async () => {
    const { buildCacheKey } = await import(`${ROOT}/hooks/lib/cache.mjs`)
    const key = await buildCacheKey([], 'test prompt')
    assert.match(key, /^[0-9a-f]{64}$/)
  })

  test('same inputs produce same key', async () => {
    const { buildCacheKey } = await import(`${ROOT}/hooks/lib/cache.mjs`)
    const k1 = await buildCacheKey([], 'hello')
    const k2 = await buildCacheKey([], 'hello')
    assert.equal(k1, k2)
  })

  test('different prompts produce different keys', async () => {
    const { buildCacheKey } = await import(`${ROOT}/hooks/lib/cache.mjs`)
    const k1 = await buildCacheKey([], 'hello')
    const k2 = await buildCacheKey([], 'world')
    assert.notEqual(k1, k2)
  })

  test('getCached returns null for missing entry', async () => {
    const { getCached } = await import(`${ROOT}/hooks/lib/cache.mjs`)
    const result = await getCached('nonexistent-key-xyz', cfg)
    assert.equal(result, null)
  })

  test('setCached then getCached returns stored value', async () => {
    const { buildCacheKey, getCached, setCached } = await import(`${ROOT}/hooks/lib/cache.mjs`)
    const key = await buildCacheKey([], `test-${Date.now()}`)
    await setCached(key, 'stored result', cfg)
    const result = await getCached(key, cfg)
    assert.equal(result, 'stored result')
  })

  test('expired entry (TTL=0) returns null', async () => {
    const { buildCacheKey, getCached, setCached } = await import(`${ROOT}/hooks/lib/cache.mjs`)
    const shortCfg = { cache: { dir: CACHE_DIR, ttlSeconds: 0 } }
    const key = await buildCacheKey([], `expired-${Date.now()}`)
    await setCached(key, 'will expire', shortCfg)
    await new Promise(r => setTimeout(r, 10))
    const result = await getCached(key, shortCfg)
    assert.equal(result, null)
  })
})
