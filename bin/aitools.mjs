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
}

if (!command || !commands[command]) {
  console.log('Usage: aitools <command>')
  console.log('')
  console.log('Commands:')
  console.log('  start   Run all tests and diagnostics')
  process.exit(1)
}

async function run(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: ROOT, stdio: 'inherit' })
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`"${bin} ${args.join(' ')}" exited with code ${code}`)))
    child.on('error', reject)
  })
}

for (const [bin, args] of commands[command]) {
  try {
    await run(bin, args)
  } catch (err) {
    console.error(err.message)
    process.exit(1)
  }
}
