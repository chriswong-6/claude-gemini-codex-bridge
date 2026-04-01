/**
 * Gemini CLI client.
 * Pipes large file content to the `gemini` CLI binary and returns a structured
 * code summary optimised as input for the subsequent Codex step.
 *
 * Authentication is handled by the gemini CLI itself (via `gemini auth login`).
 * No API key is required in this project.
 */

import { spawn, execFile } from 'child_process'
import { readFile } from 'fs/promises'
import { promisify } from 'util'
import { log, logError } from './logger.mjs'

const execFileAsync = promisify(execFile)

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
    // PDFs: extract actual text via pdftotext (decompress content streams).
    // Falls back to binary strings extraction if pdftotext is not installed.
    if (fp.toLowerCase().endsWith('.pdf')) {
      try {
        const { stdout } = await execFileAsync('pdftotext', [fp, '-'], { maxBuffer: 10 * 1024 * 1024 })
        log(2, `pdftotext extracted ${stdout.length} chars from ${fp}`)
        return `[PDF text extracted from: ${fp}]\n\n${stdout}`
      } catch {
        log(1, `pdftotext unavailable for ${fp}, falling back to binary strings extraction`)
      }
    }

    const raw = await readFile(fp, 'latin1')
    const stripped = raw.replace(/\0/g, '')

    // Binary detection: if >30% non-printable chars, extract readable strings
    // (equivalent to the `strings` command).  This is what tkaufmann's bash
    // bridge achieves implicitly — shell variable encoding drops binary bytes,
    // leaving only the printable fragments that Gemini can parse.
    const nonPrintable = (stripped.match(/[^\x09\x0a\x0d\x20-\x7e]/g) || []).length
    if (stripped.length > 0 && nonPrintable / stripped.length > 0.3) {
      const textChunks = stripped.match(/[\x20-\x7e\n\r\t]{6,}/g) || []
      const extracted = textChunks.join('\n')
      return `[Binary file — extracted readable text from: ${fp}]\n\n${extracted}`
    }

    return stripped
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
  // Escape @ to avoid gemini 0.35 interpreting @-prefixed tokens in stdin as
  // file-path references (a known bug in gemini CLI ≤0.35.3 that causes hangs).
  const stdin = fileSections.join('\n\n').replace(/@/g, '＠')

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
