/**
 * Codex integration.
 * Spawns the `codex` CLI with the Gemini summary as context, returns Codex's analysis.
 */

import { spawn } from 'child_process'
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
If the request is about understanding the code, explain it precisely.`
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

  log(1, `spawning codex (approval-mode: ${config.codex.approvalMode})`)

  return new Promise((resolve, reject) => {
    const args = [
      '--approval-mode', config.codex.approvalMode,
      '--quiet',
      prompt,
    ]

    const child = spawn(config.codex.bin, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    })

    const stdout = []
    const stderr = []

    child.stdout.on('data', d => stdout.push(d))
    child.stderr.on('data', d => stderr.push(d))

    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`Codex timed out after ${config.codex.timeoutMs}ms`))
    }, config.codex.timeoutMs)

    child.on('close', code => {
      clearTimeout(timer)
      const out = Buffer.concat(stdout).toString('utf8').trim()
      const err = Buffer.concat(stderr).toString('utf8').trim()

      if (code !== 0) {
        logError(`Codex exited ${code}: ${err}`)
        reject(new Error(`Codex exited with code ${code}: ${err}`))
        return
      }

      log(1, `Codex response: ${out.length} chars`)
      resolve(out)
    })

    child.on('error', err => {
      clearTimeout(timer)
      reject(new Error(`Failed to spawn codex: ${err.message}`))
    })
  })
}
