/**
 * Configuration loader — merges defaults.json with environment variable overrides.
 */

import { readFile } from 'fs/promises'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'
import { homedir } from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url))

let _config = null

export async function loadConfig() {
  if (_config) return _config

  const defaultsPath = join(__dirname, '../../config/defaults.json')
  const defaults = JSON.parse(await readFile(defaultsPath, 'utf8'))

  _config = {
    routing: {
      claudeTokenLimit:   parseInt(process.env.CLAUDE_TOKEN_LIMIT  ?? defaults.routing.claudeTokenLimit),
      geminiTokenLimit:   parseInt(process.env.GEMINI_TOKEN_LIMIT  ?? defaults.routing.geminiTokenLimit),
      maxTotalSizeBytes:  parseInt(process.env.MAX_TOTAL_SIZE_BYTES ?? defaults.routing.maxTotalSizeBytes),
      minFilesForTask:    parseInt(process.env.MIN_FILES_FOR_TASK   ?? defaults.routing.minFilesForTask),
      charsPerToken:      defaults.routing.charsPerToken,
    },
    gemini: {
      bin:         process.env.GEMINI_BIN          ?? defaults.gemini.bin,
      timeoutMs:   parseInt(process.env.GEMINI_TIMEOUT_MS   ?? defaults.gemini.timeoutMs),
      rateLimitMs: parseInt(process.env.GEMINI_RATE_LIMIT_MS ?? defaults.gemini.rateLimitMs),
    },
    codex: {
      approvalMode: process.env.CODEX_APPROVAL_MODE ?? defaults.codex.approvalMode,
      timeoutMs:    parseInt(process.env.CODEX_TIMEOUT_MS ?? defaults.codex.timeoutMs),
      // Path to codex binary; auto-resolved if not set
      bin:          process.env.CODEX_BIN ?? 'codex',
    },
    cache: {
      ttlSeconds: parseInt(process.env.CACHE_TTL_SECONDS ?? defaults.cache.ttlSeconds),
      dir: process.env.CACHE_DIR
        ?? join(homedir(), '.claude-gemini-codex-bridge', 'cache'),
    },
    security: defaults.security,
    debug: {
      level:  parseInt(process.env.DEBUG_LEVEL ?? defaults.debug.level),
      logDir: process.env.LOG_DIR
        ?? join(homedir(), '.claude-gemini-codex-bridge', 'logs'),
    },
  }

  return _config
}
