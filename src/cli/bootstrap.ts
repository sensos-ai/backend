#!/usr/bin/env bun

import { join } from 'node:path'
import { HELP_TEXT, isHelpRequest } from './commands/help'

if (isHelpRequest(process.argv.slice(2))) {
  console.log(HELP_TEXT)
  process.exit(0)
}

const logLevel = process.env.SENSOS_LOG_LEVEL?.trim() || 'off'

if (process.env.SENSOS_LOGGING_READY !== '1') {
  const isCompiled = process.argv[1]?.startsWith('/$bunfs/') ?? false
  const command = isCompiled
    ? [process.execPath, ...process.argv.slice(2)]
    : [process.execPath, ...process.argv.slice(1)]
  const child = Bun.spawn(command, {
    env: {
      ...process.env,
      SENSOS_LOGGING_READY: '1',
      SENSOS_AI_EVENT_LOG_PATH:
        process.env.SENSOS_AI_EVENT_LOG_PATH ??
        join(process.cwd(), 'log.txt'),
      RIVET_LOG_LEVEL: logLevel,
      RUST_LOG: logLevel,
    },
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })

  process.exit(await child.exited)
}

await import('./index')
