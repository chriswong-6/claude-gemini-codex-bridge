/**
 * Pending review flag — set by /bridge-review <path> slash command.
 *
 * When set:
 * - pre-tool-use forces Gemini delegation regardless of file size
 * - Stop hook runs Codex using this review type even when mode=off
 *
 * Value: 'review' | 'adversarial' | null
 */

import { readFile, writeFile, unlink, mkdir } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'

const STATE_DIR = join(homedir(), '.claude-gemini-codex-bridge')
const FLAG_FILE = join(STATE_DIR, 'pending-review')

export async function setPendingReview(type) {
  await mkdir(STATE_DIR, { recursive: true })
  await writeFile(FLAG_FILE, type, 'utf8')
}

export async function getPendingReview() {
  try {
    const val = (await readFile(FLAG_FILE, 'utf8')).trim()
    return ['review', 'adversarial'].includes(val) ? val : null
  } catch {
    return null
  }
}

export async function clearPendingReview() {
  try { await unlink(FLAG_FILE) } catch {}
}
