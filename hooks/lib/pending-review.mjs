/**
 * Pending review flag — set by /bridge-review <path> slash command.
 *
 * When set:
 * - pre-tool-use forces Gemini delegation regardless of file size
 * - Stop hook runs Codex using this review type even when mode=off,
 *   using the stored paths if Claude didn't write any files this turn
 *
 * Format: { type: 'review'|'adversarial', paths: string[] }
 */

import { readFile, writeFile, unlink, mkdir } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'

const STATE_DIR = join(homedir(), '.claude-gemini-codex-bridge')
const FLAG_FILE = join(STATE_DIR, 'pending-review')

export async function setPendingReview(type, paths = []) {
  await mkdir(STATE_DIR, { recursive: true })
  await writeFile(FLAG_FILE, JSON.stringify({ type, paths }), 'utf8')
}

export async function getPendingReview() {
  try {
    const raw = (await readFile(FLAG_FILE, 'utf8')).trim()
    // JSON format: { type, paths }
    try {
      const val = JSON.parse(raw)
      if (['review', 'adversarial'].includes(val.type)) {
        return { type: val.type, paths: Array.isArray(val.paths) ? val.paths : [] }
      }
    } catch {}
    // Legacy plain-string format
    if (['review', 'adversarial'].includes(raw)) return { type: raw, paths: [] }
    return null
  } catch {
    return null
  }
}

export async function clearPendingReview() {
  try { await unlink(FLAG_FILE) } catch {}
}
