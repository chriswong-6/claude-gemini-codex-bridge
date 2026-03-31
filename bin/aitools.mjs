#!/usr/bin/env node

import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

const command = process.argv[2]

const commands = {
  start: [
    ['node', ['--test', 'test/unit.test.mjs']],
    ['node', ['--test', 'test/integration.test.mjs']],
    ['node', ['test/check.mjs']],
  ],
  live: [
    ['node', ['test/check.mjs', '--live']],
    ['node', ['--test', 'test/live.test.mjs']],
  ],
}

async function run(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: ROOT, stdio: 'inherit' })
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`"${bin} ${args.join(' ')}" exited with code ${code}`)))
    child.on('error', reject)
  })
}

if (command === 'trace') {
  // Pass through extra flags (--all, --watch) directly to trace.mjs
  const extraArgs = process.argv.slice(3)
  const child = spawn('node', [join(ROOT, 'test/trace.mjs'), ...extraArgs], {
    cwd: ROOT, stdio: 'inherit',
  })
  child.on('close', code => process.exit(code ?? 0))
  child.on('error', err => { console.error(err.message); process.exit(1) })

} else if (!command || !commands[command]) {
  console.log('Usage: aitools <command>')
  console.log('')
  console.log('Commands:')
  console.log('  start          Run all tests and diagnostics (mock, no auth needed)')
  console.log('  live           Run live tests against real CLIs (auth required)')
  console.log('  trace          Check the latest real invocation trace')
  console.log('  trace --all    Check all traces from today')
  console.log('  trace --watch  Watch for new traces in real-time')
  process.exit(1)

} else {
  for (const [bin, args] of commands[command]) {
    try {
      await run(bin, args)
    } catch (err) {
      console.error(err.message)
      process.exit(1)
    }
  }
}
