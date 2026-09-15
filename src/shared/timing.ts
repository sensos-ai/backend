import { appendFileSync } from 'node:fs'

export const TIMING_LOGS_ENV = 'SENSOS_TIMING_LOGS'
export const TIMING_LOG_PATH_ENV = 'SENSOS_TIMING_LOG_PATH'

type TimingValue = boolean | number | string | null | undefined

export function timingRecord(
  event: string,
  fields: Readonly<Record<string, TimingValue>> = {},
  now = Date.now()
): string {
  return JSON.stringify({
    type: 'sensos_timing',
    event,
    at: new Date(now).toISOString(),
    atMs: now,
    ...fields,
  })
}

export function recordTiming(
  event: string,
  fields: Readonly<Record<string, TimingValue>> = {}
): void {
  const path = process.env[TIMING_LOG_PATH_ENV]?.trim()
  const line = timingRecord(event, fields)
  if (path) {
    try {
      appendFileSync(path, `${line}\n`, { mode: 0o600 })
    } catch {
      // Diagnostics must never break the command being measured.
    }
  }
  if (process.env[TIMING_LOGS_ENV] === '1') console.error(line)
}
