import { setup } from 'rivetkit'
import { sessionAgent } from '@/runtime/actors/session'

export const registry = setup({
  use: { session: sessionAgent },
  runtime: 'native',
  endpoint: 'http://127.0.0.1:6420',
  startEngine: false,
  startServices: false,
  noWelcome: true,
  logging: {
    level: process.env.SENSOS_LOG_LEVEL === 'warn' ? 'warn' : 'silent',
  },
  shutdown: { disableSignalHandlers: true, gracePeriodMs: 5_000 },
})
