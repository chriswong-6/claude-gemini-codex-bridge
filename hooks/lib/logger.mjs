/**
 * Debug logger — writes to stderr so it never pollutes the hook's stdout JSON output.
 * Level: 0=off  1=basic  2=verbose  3=trace
 */

import { appendFile, mkdir } from 'fs/promises'
import { join } from 'path'

let _level = 0
let _logDir = null
let _logFile = null

export function initLogger(level, logDir) {
  _level = level ?? 0
  _logDir = logDir ?? null
  if (_logDir) {
    const date = new Date().toISOString().slice(0, 10)
    _logFile = join(_logDir, `bridge-${date}.log`)
  }
}

async function write(prefix, msg) {
  const line = `[${new Date().toISOString()}] ${prefix} ${msg}`
  process.stderr.write(line + '\n')
  if (_logFile) {
    try {
      await mkdir(_logDir, { recursive: true })
      await appendFile(_logFile, line + '\n')
    } catch {
      // never crash the hook due to log failures
    }
  }
}

export function log(level, msg) {
  if (level <= _level) {
    write(`[L${level}]`, msg).catch(() => {})
  }
}

export function logError(msg) {
  write('[ERROR]', msg).catch(() => {})
}
