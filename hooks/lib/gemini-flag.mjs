/**
 * Gemini-used flag — set by pre-tool-use when Gemini runs, cleared by stop-review.
 * Lets the Stop hook know it should run Codex even when bridge mode is off.
 */

import { readFile, writeFile, unlink, mkdir } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'

const STATE_DIR = join(homedir(), '.claude-gemini-codex-bridge')
const FLAG_FILE = join(STATE_DIR, 'gemini-used')

export async function setGeminiUsed() {
  await mkdir(STATE_DIR, { recursive: true })
  await writeFile(FLAG_FILE, '1', 'utf8')
}

export async function getGeminiUsed() {
  try {
    await readFile(FLAG_FILE, 'utf8')
    return true
  } catch {
    return false
  }
}

export async function clearGeminiUsed() {
  try { await unlink(FLAG_FILE) } catch {}
}
