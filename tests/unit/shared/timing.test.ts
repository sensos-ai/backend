import { expect, test } from 'bun:test'
import { timingRecord } from '@/shared/timing'

test('timing records are structured and deterministic', () => {
  expect(
    JSON.parse(
      timingRecord('actor.agentos.ready', { elapsedMs: 42 }, 1_000)
    )
  ).toEqual({
    type: 'sensos_timing',
    event: 'actor.agentos.ready',
    at: '1970-01-01T00:00:01.000Z',
    atMs: 1_000,
    elapsedMs: 42,
  })
})
