/**
 * Bridge mode state — persisted to ~/.claude-gemini-codex-bridge/mode
 *
 * Modes:
 *   review      — auto-trigger Gemini → Codex review on large files (default)
 *   adversarial — auto-trigger Gemini → Codex adversarial review on large files
 *   off         — bridge disabled; all tool calls pass through directly
 */

import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'

const STATE_DIR = join(homedir(), '.claude-gemini-codex-bridge')
const MODE_FILE = join(STATE_DIR, 'mode')

const VALID_MODES = ['review', 'adversarial', 'off']

export async function getMode() {
  try {
    const content = await readFile(MODE_FILE, 'utf8')
    const mode = content.trim()
    return VALID_MODES.includes(mode) ? mode : 'review'
  } catch {
    return 'review'
  }
}

export async function setMode(mode) {
  if (!VALID_MODES.includes(mode)) throw new Error(`Unknown mode: ${mode}`)
  await mkdir(STATE_DIR, { recursive: true })
  await writeFile(MODE_FILE, mode, 'utf8')
}
