/**
 * Codex integration.
 * Spawns the `codex exec` CLI with the Gemini summary as context, returns Codex's analysis.
 */

import { spawn } from 'child_process'
import { writeFile, readFile, unlink, mkdtemp } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { log, logError } from './logger.mjs'

/**
 * Build the task prompt that Codex receives.
 * Gemini's summary is embedded as context; the original user intent drives the task.
 */
function buildCodexPrompt(geminiSummary, originalPrompt, toolName) {
  return `## Context (pre-analysed by Gemini)

The following is a structured summary of a large codebase section that was too large
to pass directly. It was produced by Gemini from the original files.

${geminiSummary}

---

## Your Task

Based on the context above, answer the following request:

Original tool: ${toolName}
Request: ${originalPrompt}

Provide a thorough, actionable response. If you find code issues, list them clearly.
If the request is about understanding the code, explain it precisely.
Do NOT execute any shell commands — provide analysis only.`
}

/**
 * @param {string} geminiSummary   Output from the Gemini step
 * @param {string} originalPrompt  Original user intent / tool prompt
 * @param {string} toolName
 * @param {string} cwd             Working directory for Codex to run in
 * @param {object} config
 * @returns {string} Codex's response
 */
export async function analyseWithCodex(geminiSummary, originalPrompt, toolName, cwd, config) {
  const prompt = buildCodexPrompt(geminiSummary, originalPrompt, toolName)

  log(1, 'spawning codex exec (non-interactive analysis)')

  // Use a temp file to capture the last message from codex exec
  const tmpDir = await mkdtemp(join(tmpdir(), 'bridge-codex-'))
  const outFile = join(tmpDir, 'response.txt')

  return new Promise((resolve, reject) => {
    const args = [
      'exec',
      '--dangerously-bypass-approvals-and-sandbox',
      '--ephemeral',
      '--skip-git-repo-check',
      '-o', outFile,
      prompt,
    ]

    const child = spawn(config.codex.bin, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    })

    // Close stdin immediately — codex exec reads it as "additional input"
    // if left open; closing it signals EOF so codex proceeds with the prompt arg.
    child.stdin.on('error', () => {})
    child.stdin.end()

    const stderr = []
    child.stderr.on('data', d => stderr.push(d))

    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`Codex timed out after ${config.codex.timeoutMs}ms`))
    }, config.codex.timeoutMs)

    child.on('close', async code => {
      clearTimeout(timer)
      const err = Buffer.concat(stderr).toString('utf8').trim()

      if (code !== 0) {
        logError(`Codex exited ${code}: ${err}`)
        reject(new Error(`Codex exited with code ${code}: ${err}`))
        return
      }

      try {
        const out = (await readFile(outFile, 'utf8')).trim()
        await unlink(outFile).catch(() => {})
        if (!out) {
          reject(new Error('Codex returned empty output'))
          return
        }
        log(1, `Codex response: ${out.length} chars`)
        resolve(out)
      } catch (readErr) {
        reject(new Error(`Failed to read Codex output: ${readErr.message}`))
      }
    })

    child.on('error', err => {
      clearTimeout(timer)
      reject(new Error(`Failed to spawn codex: ${err.message}`))
    })
  })
}
