import { resolve } from 'node:path'
import { computeRuntimeSourceIdentity } from './build-identity'

declare const __SENSOS_RUNTIME_BUILD_ID__: string

export const RUNTIME_HOST = '127.0.0.1'
const configuredRuntimePort = Number(
  process.env.SENSOS_RUNTIME_PORT ?? 6420
)
if (
  !Number.isInteger(configuredRuntimePort) ||
  configuredRuntimePort < 1
) {
  throw new Error('SENSOS_RUNTIME_PORT must be a positive integer')
}
export const RUNTIME_PORT = configuredRuntimePort
export const RUNTIME_ENDPOINT = `http://${RUNTIME_HOST}:${RUNTIME_PORT}`
export const RUNTIME_STREAMS_PORT = RUNTIME_PORT + 2
export const RUNTIME_STREAMS_ENDPOINT = `http://${RUNTIME_HOST}:${RUNTIME_STREAMS_PORT}`
export const RUNTIME_BUILD_ID =
  typeof __SENSOS_RUNTIME_BUILD_ID__ === 'undefined'
    ? computeRuntimeSourceIdentity(resolve(import.meta.dir, '../..'))
    : __SENSOS_RUNTIME_BUILD_ID__
export const DEFAULT_IDLE_TTL_MS = 5 * 60_000
export const MAX_IDLE_TTL_MS = 24 * 60 * 60_000
export const HEARTBEAT_INTERVAL_MS = 30_000
export const LEASE_TIMEOUT_MS = 90_000
