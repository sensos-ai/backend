import { describe, expect, test } from 'bun:test'
import { resolveRunOutcome } from '@/runtime/actors/session/workflow/steps/execute-run'

describe('resolveRunOutcome', () => {
  test('gives cancellation and interruption precedence', () => {
    expect(
      resolveRunOutcome({
        outcome: { status: 'completed' },
        cancelled: true,
        interrupted: false,
        workflowAborted: false,
      }).status
    ).toBe('cancelled')
    expect(
      resolveRunOutcome({
        outcome: { status: 'completed' },
        cancelled: false,
        interrupted: true,
        workflowAborted: false,
      }).status
    ).toBe('interrupted')
    expect(
      resolveRunOutcome({
        outcome: { status: 'completed' },
        cancelled: false,
        interrupted: false,
        workflowAborted: true,
      }).status
    ).toBe('interrupted')
  })
  test('maps terminal stream outcomes', () => {
    expect(
      resolveRunOutcome({
        outcome: { status: 'completed' },
        finishReason: 'stop',
        cancelled: false,
        interrupted: false,
        workflowAborted: false,
      }).status
    ).toBe('completed')
    expect(
      resolveRunOutcome({
        outcome: { status: 'failed', error: 'boom' },
        cancelled: false,
        interrupted: false,
        workflowAborted: false,
      })
    ).toMatchObject({ status: 'failed', error: 'boom' })
    expect(
      resolveRunOutcome({
        outcome: { status: 'unknown' },
        cancelled: false,
        interrupted: false,
        workflowAborted: false,
      }).status
    ).toBe('failed')
  })
})
