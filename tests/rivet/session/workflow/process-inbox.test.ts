import { describe, expect, test } from 'bun:test'
import { decideInboxRoute } from '@/runtime/actors/session/workflow/steps/process-inbox'

describe('decideInboxRoute', () => {
  test('interrupts now and adaptively steers only with an active run', () => {
    expect(
      decideInboxRoute({
        priority: 'now',
        hasActiveRun: true,
        waitingForHumanInput: false,
      })
    ).toEqual({ kind: 'steer', mode: 'interrupt' })
    expect(
      decideInboxRoute({
        priority: 'adaptive',
        hasActiveRun: true,
        waitingForHumanInput: false,
      })
    ).toEqual({ kind: 'steer', mode: 'adaptive' })
    expect(
      decideInboxRoute({
        priority: 'adaptive',
        hasActiveRun: false,
        waitingForHumanInput: false,
      })
    ).toEqual({ kind: 'queue' })
  })
  test('refuses now while waiting for input and otherwise queues', () => {
    expect(
      decideInboxRoute({
        priority: 'now',
        hasActiveRun: false,
        waitingForHumanInput: true,
      })
    ).toEqual({ kind: 'refuse', reason: 'waiting_for_input' })
    expect(
      decideInboxRoute({
        priority: 'next',
        hasActiveRun: true,
        waitingForHumanInput: false,
      })
    ).toEqual({ kind: 'queue' })
  })
})
