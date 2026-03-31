/**
 * SHA-256 content-based cache with TTL.
 * Key: hash of (file contents + metadata + prompt).
 * Value: final pipeline result string.
 */

import { createHash } from 'crypto'
import { readFile, writeFile, stat, mkdir } from 'fs/promises'
import { join } from 'path'
import { log } from './logger.mjs'

/**
 * Build a cache key from file paths + prompt.
 * Uses file content hash so stale entries are auto-invalidated when files change.
 */
export async function buildCacheKey(filePaths, prompt) {
  const h = createHash('sha256')
  h.update(prompt ?? '')
  for (const fp of filePaths) {
    try {
      const content = await readFile(fp)
      h.update(fp)
      h.update(content)
    } catch {
      h.update(fp)
    }
  }
  return h.digest('hex')
}

export async function getCached(key, config) {
  const file = join(config.cache.dir, `${key}.json`)
  try {
    const s = await stat(file)
    const ageSeconds = (Date.now() - s.mtimeMs) / 1000
    if (ageSeconds > config.cache.ttlSeconds) {
      log(2, `cache expired: ${key} (${Math.round(ageSeconds)}s old)`)
      return null
    }
    const raw = JSON.parse(await readFile(file, 'utf8'))
    log(1, `cache hit: ${key}`)
    return raw.result
  } catch {
    return null
  }
}

export async function setCached(key, result, config) {
  try {
    await mkdir(config.cache.dir, { recursive: true })
    await writeFile(
      join(config.cache.dir, `${key}.json`),
      JSON.stringify({ result, savedAt: new Date().toISOString() }),
      'utf8'
    )
    log(2, `cache stored: ${key}`)
  } catch (err) {
    log(1, `cache write failed: ${err.message}`)
  }
}
