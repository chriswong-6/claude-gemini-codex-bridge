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
 * mode: 'review' (default) | 'adversarial'
 */
function buildCodexPrompt(geminiSummary, originalPrompt, toolName, mode = 'review') {
  if (mode === 'adversarial') {
    return `<role>
You are Codex performing an adversarial software review.
Your job is to break confidence in the change, not to validate it.
</role>

<task>
Review the provided context as if you are trying to find the strongest reasons
this code should not ship yet.
Request: ${originalPrompt}
</task>

<operating_stance>
Default to skepticism.
Assume the code can fail in subtle, high-cost, or user-visible ways until the evidence says otherwise.
Do not give credit for good intent, partial fixes, or likely follow-up work.
If something only works on the happy path, treat that as a real weakness.
</operating_stance>

<attack_surface>
Prioritize the kinds of failures that are expensive, dangerous, or hard to detect:
- auth, permissions, tenant isolation, and trust boundaries
- data loss, corruption, duplication, and irreversible state changes
- rollback safety, retries, partial failure, and idempotency gaps
- race conditions, ordering assumptions, stale state, and re-entrancy
- empty-state, null, timeout, and degraded dependency behavior
- version skew, schema drift, migration hazards, and compatibility regressions
- observability gaps that would hide failure or make recovery harder
</attack_surface>

<review_method>
Actively try to disprove the code.
Look for violated invariants, missing guards, unhandled failure paths, and assumptions
that stop being true under stress.
If the user supplied a focus area, weight it heavily, but still report any other material issue.
</review_method>

<finding_bar>
Report only material findings.
Do not include style feedback, naming feedback, or low-value cleanup.
Each finding should answer:
1. What can go wrong?
2. Why is this code path vulnerable?
3. What is the likely impact?
4. What concrete change would reduce the risk?
</finding_bar>

<grounding_rules>
Be aggressive, but stay grounded.
Every finding must be defensible from the provided context.
Do not invent files, code paths, or runtime behaviour you cannot support.
If a conclusion depends on an inference, state that explicitly.
</grounding_rules>

<context>
The following is a structured summary produced by Gemini from the original files:

${geminiSummary}
</context>`
  }

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
export async function analyseWithCodex(geminiSummary, originalPrompt, toolName, cwd, config, mode = 'review') {
  const prompt = buildCodexPrompt(geminiSummary, originalPrompt, toolName, mode)

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
