/**
 * Interactive TTY prompt for degradation decisions.
 *
 * The hook's stdin is occupied by the Claude Code protocol (tool call JSON),
 * so we open /dev/tty directly to read user input from the terminal.
 *
 * In non-interactive environments (CI, tests, no TTY) returns false so the
 * hook falls back to approve — same as the previous silent behaviour.
 */

import { openSync, writeSync, readSync, closeSync } from 'fs'

/**
 * Writes a prompt to the terminal and waits for y/N input.
 *
 * @param {string} component  Name of the unavailable component ('Gemini' | 'Codex')
 * @param {string} detail     Short description of what degraded mode means
 * @returns {Promise<boolean>} true = user accepted degradation
 */
export async function promptDegradation(component, detail) {
  // Non-interactive override: set by tests or CI to skip TTY prompting
  if (process.env.BRIDGE_NO_PROMPT) return null

  try {
    const ttyFd = openSync('/dev/tty', 'r+')

    const msg = [
      '',
      `\x1b[33m[bridge]\x1b[0m \x1b[1m${component} is unavailable.\x1b[0m`,
      `  Degraded mode: ${detail}`,
      `  Accept degradation? [y/N] `,
    ].join('\n')

    writeSync(ttyFd, msg)

    const buf = Buffer.alloc(256)
    const n = readSync(ttyFd, buf, 0, 256, null)
    closeSync(ttyFd)

    const answer = buf.slice(0, n).toString('utf8').trim().toLowerCase()
    const accepted = answer === 'y' || answer === 'yes'

    // Echo result back to terminal
    try {
      const ttyOut = openSync('/dev/tty', 'w')
      writeSync(ttyOut, accepted ? '\x1b[32m  → Accepted. Proceeding in degraded mode.\x1b[0m\n' : '\x1b[31m  → Declined. Blocking tool call.\x1b[0m\n')
      closeSync(ttyOut)
    } catch { /* ignore */ }

    return accepted
  } catch {
    // No TTY (CI, tests, piped stdin) — non-interactive fallback: approve silently
    return null  // null = non-interactive, caller should approve without prompting
  }
}
