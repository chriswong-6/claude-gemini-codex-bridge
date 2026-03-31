/**
 * Tracer — writes a JSON trace file for every hook invocation.
 * Each trace captures the full data flow so aitools trace can
 * replay and validate it against the described pipeline.
 */

import { writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'

function traceDir(config) {
  return process.env.TRACE_DIR
    ?? join(homedir(), '.claude-gemini-codex-bridge', 'traces')
}

export async function writeTrace(trace, config) {
  try {
    const dir = traceDir(config)
    await mkdir(dir, { recursive: true })
    // filename: timestamp so they sort chronologically
    const name = `${trace.timestamp.replace(/[:.]/g, '-')}.json`
    await writeFile(join(dir, name), JSON.stringify(trace, null, 2), 'utf8')
  } catch {
    // never crash the hook due to trace write failure
  }
}
