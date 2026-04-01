/**
 * Session file tracker — records files written/edited by Claude during a turn.
 * Used by the Stop hook to know which files to pass through Gemini → Codex review.
 */

import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'

const STATE_DIR = join(homedir(), '.claude-gemini-codex-bridge')
const FILE      = join(STATE_DIR, 'session-files.json')

export async function getSessionFiles() {
  try {
    return JSON.parse(await readFile(FILE, 'utf8'))
  } catch {
    return []
  }
}

export async function addSessionFile(filePath) {
  const files = await getSessionFiles()
  if (!files.includes(filePath)) {
    files.push(filePath)
    await mkdir(STATE_DIR, { recursive: true })
    await writeFile(FILE, JSON.stringify(files), 'utf8')
  }
}

export async function clearSessionFiles() {
  await mkdir(STATE_DIR, { recursive: true })
  await writeFile(FILE, '[]', 'utf8')
}
