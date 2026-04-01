#!/usr/bin/env node

import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { getMode, setMode } from '../hooks/lib/mode.mjs'

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

} else if (command === 'mode') {
  const newMode = process.argv[3]
  if (!newMode) {
    const current = await getMode()
    console.log(`Bridge mode: ${current}`)
  } else if (['review', 'adversarial', 'off'].includes(newMode)) {
    await setMode(newMode)
    const labels = { review: 'Review mode ON', adversarial: 'Adversarial mode ON', off: 'Bridge OFF' }
    console.log(`Bridge: ${labels[newMode]}`)
  } else {
    console.error(`Unknown mode: ${newMode}. Use: review, adversarial, off`)
    process.exit(1)
  }

} else if (command === 'review' || command === 'adversarial') {
  const rest = process.argv.slice(3)
  if (rest.length === 0) {
    console.error(`Usage: aitools ${command} <file|--text="..."> [file...]`)
    process.exit(1)
  }
  const child = spawn('node', [
    join(ROOT, 'hooks/bridge-run.mjs'),
    `--mode=${command}`,
    ...rest,
  ], { cwd: ROOT, stdio: 'inherit' })
  child.on('close', code => process.exit(code ?? 0))
  child.on('error', err => { console.error(err.message); process.exit(1) })

} else if (!command || !commands[command]) {
  console.log('Usage: aitools <command>')
  console.log('')
  console.log('Commands:')
  console.log('  start                   Run all tests and diagnostics (mock, no auth needed)')
  console.log('  live                    Run live tests against real CLIs (auth required)')
  console.log('  trace                   Check if the last real invocation matched the described workflow')
  console.log('  mode [review|adversarial|off]  Get or set bridge auto-trigger mode')
  console.log('  review <file>           Run Gemini → Codex code review on a file (any size)')
  console.log('  adversarial <file>      Run Gemini → Codex adversarial review on a file (any size)')
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
