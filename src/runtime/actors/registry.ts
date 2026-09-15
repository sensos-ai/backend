import { setup } from 'rivetkit'
import { sessionAgent } from '@/runtime/actors/session'
import { RUNTIME_ENDPOINT } from '@/runtime/constants'

export const registry = setup({
  use: { session: sessionAgent },
  runtime: 'native',
  endpoint: process.env.RIVET_ENDPOINT ?? RUNTIME_ENDPOINT,
  startEngine: false,
  startServices: false,
  noWelcome: true,
  logging: {
    level: process.env.SENSOS_LOG_LEVEL === 'warn' ? 'warn' : 'silent',
  },
  shutdown: { disableSignalHandlers: true, gracePeriodMs: 5_000 },
})
