/**
 * Gemini CLI client.
 * Pipes large file content to the `gemini` CLI binary and returns a structured
 * code summary optimised as input for the subsequent Codex step.
 *
 * Authentication is handled by the gemini CLI itself (via `gemini auth login`).
 * No API key is required in this project.
 */

import { spawn } from 'child_process'
import { readFile } from 'fs/promises'
import { log, logError } from './logger.mjs'

// Rate-limit state (in-process)
let _lastCallMs = 0

function buildPrompt(toolName, originalPrompt) {
  return `You are a senior software engineer helping another AI (Codex) \
understand a large codebase. Your output will be fed directly into Codex as context.

Original request: "${originalPrompt}"
Tool that triggered this: ${toolName}

Analyse the following file(s) and produce a STRUCTURED SUMMARY containing:
1. Purpose and responsibility of each file
2. Public API: exported functions/classes/constants with their signatures
3. Key internal logic worth knowing (algorithms, data flows, side-effects)
4. Dependencies and inter-file relationships
5. Anything unusual, risky, or worth a code-review flag

Be concise but complete. Codex will act on this summary — do NOT omit details \
that could affect correctness.`
}

async function readFileSafe(fp) {
  try {
    // Read as latin1 (1 byte → 1 char, no inflation) then strip NUL bytes —
    // the same behaviour as bash `$(cat file)`, which allows binary files like
    // PDFs to be piped to gemini without hanging (text fragments survive intact).
    const raw = await readFile(fp, 'latin1')
    return raw.replace(/\0/g, '')
  } catch {
    return `[Could not read file: ${fp}]`
  }
}

async function enforceRateLimit(rateLimitMs) {
  const wait = rateLimitMs - (Date.now() - _lastCallMs)
  if (wait > 0) {
    log(2, `rate limit: waiting ${wait}ms`)
    await new Promise(r => setTimeout(r, wait))
  }
  _lastCallMs = Date.now()
}

/**
 * @param {string}   toolName
 * @param {string[]} filePaths
 * @param {string}   originalPrompt
 * @param {object}   config
 * @returns {string} Gemini's structured summary
 */
export async function summariseWithGemini(toolName, filePaths, originalPrompt, config) {
  await enforceRateLimit(config.gemini.rateLimitMs)

  // Build stdin: prompt header + file contents
  const prompt = buildPrompt(toolName, originalPrompt)
  const fileSections = []
  for (const fp of filePaths) {
    const content = await readFileSafe(fp)
    fileSections.push(`=== File: ${fp} ===\n\n${content}`)
  }
  const stdin = fileSections.join('\n\n')

  log(1, `calling gemini CLI (${config.gemini.bin}) for ${filePaths.length} file(s)`)

  return new Promise((resolve, reject) => {
    const child = spawn(config.gemini.bin, ['-p', prompt], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    })

    const stdout = []
    const stderr = []

    child.stdout.on('data', d => stdout.push(d))
    child.stderr.on('data', d => stderr.push(d))

    // Pipe file contents to stdin then close.
    // Ignore EPIPE — some stub/fast-exit binaries close stdin early.
    child.stdin.on('error', () => {})
    child.stdin.write(stdin, 'latin1')
    child.stdin.end()

    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`gemini CLI timed out after ${config.gemini.timeoutMs}ms`))
    }, config.gemini.timeoutMs)

    child.on('close', code => {
      clearTimeout(timer)
      const out = Buffer.concat(stdout).toString('utf8').trim()
      const err = Buffer.concat(stderr).toString('utf8').trim()

      if (code !== 0) {
        logError(`gemini CLI exited ${code}: ${err}`)
        reject(new Error(`gemini CLI exited with code ${code}: ${err}`))
        return
      }

      if (!out) {
        reject(new Error('gemini CLI returned empty output'))
        return
      }

      log(1, `Gemini summary: ${out.length} chars`)
      resolve(out)
    })

    child.on('error', err => {
      clearTimeout(timer)
      reject(new Error(`Failed to spawn gemini CLI: ${err.message}`))
    })
  })
}
