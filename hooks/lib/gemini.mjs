/**
 * Gemini API client.
 * Sends large file content to Gemini and returns a structured code summary
 * optimised as input for the subsequent Codex step.
 */

import { readFile } from 'fs/promises'
import { log, logError } from './logger.mjs'

// Rate-limit state (in-process; fine for a single-process hook)
let _lastCallMs = 0

function buildPrompt(toolName, filePaths, originalPrompt) {
  const header = `You are a senior software engineer helping another AI (Codex) \
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
that could affect correctness.

---FILES---`

  return header
}

async function readFileSafe(fp) {
  try {
    return await readFile(fp, 'utf8')
  } catch {
    return `[Could not read file: ${fp}]`
  }
}

async function enforceRateLimit(rateLimitMs) {
  const now = Date.now()
  const wait = rateLimitMs - (now - _lastCallMs)
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
  if (!config.gemini.apiKey) {
    throw new Error('GEMINI_API_KEY is not set')
  }

  await enforceRateLimit(config.gemini.rateLimitMs)

  // Build request body
  const parts = [{ text: buildPrompt(toolName, filePaths, originalPrompt) }]

  for (const fp of filePaths) {
    const content = await readFileSafe(fp)
    parts.push({ text: `\n\n### File: ${fp}\n\`\`\`\n${content}\n\`\`\`` })
  }

  const body = {
    contents: [{ parts }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 8192,
    },
  }

  // GEMINI_API_URL can override the base URL (used in tests to point at a mock server)
  const baseUrl = process.env.GEMINI_API_URL
    ?? 'https://generativelanguage.googleapis.com/v1beta'
  const url = `${baseUrl}/models/${config.gemini.model}:generateContent?key=${config.gemini.apiKey}`

  log(1, `calling Gemini (${config.gemini.model}) for ${filePaths.length} file(s)`)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.gemini.timeoutMs)

  let resp
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`Gemini API error ${resp.status}: ${text}`)
  }

  const json = await resp.json()
  const summary = json?.candidates?.[0]?.content?.parts?.[0]?.text

  if (!summary) {
    throw new Error('Gemini returned empty response')
  }

  log(1, `Gemini summary: ${summary.length} chars`)
  return summary
}
