#!/usr/bin/env bun

import { join } from 'node:path'
import { normalizeCliInvocation } from './state'

const invocation = normalizeCliInvocation(process.argv.slice(2))
process.argv.splice(2, process.argv.length - 2, ...invocation.argv)
process.env.SENSOS_CLI_INTERACTIVE = invocation.state.isInteractive
  ? '1'
  : '0'

const logLevel = process.env.SENSOS_LOG_LEVEL?.trim() || 'off'

if (process.env.SENSOS_LOGGING_READY !== '1') {
  const isCompiled = process.argv[1]?.startsWith('/$bunfs/') ?? false
  const command = isCompiled
    ? [process.execPath, ...invocation.argv]
    : [process.execPath, process.argv[1] as string, ...invocation.argv]
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
