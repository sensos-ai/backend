import { describe, expect, test } from 'bun:test'
import {
  resolveRuntimeIdleTtl,
  shouldDeferRuntimeIdleShutdown,
} from '../../../src/runtime'
import {
  onRuntimeActivityChange,
  releaseRuntimeActivity,
  retainRuntimeActivity,
  runtimeActivityCount,
} from '../../../src/runtime/activity'

describe('runtime idle TTL', () => {
  test('uses an intentional bounded configuration', () => {
    expect(resolveRuntimeIdleTtl(undefined)).toBe(300_000)
    expect(resolveRuntimeIdleTtl('0')).toBe(0)
    expect(resolveRuntimeIdleTtl('1500')).toBe(1500)
    expect(() => resolveRuntimeIdleTtl('nope')).toThrow(
      'must be a non-negative integer'
    )
    expect(() => resolveRuntimeIdleTtl('-1')).toThrow()
    expect(() => resolveRuntimeIdleTtl('86400001')).toThrow(
      'must be between'
    )
  })

  test('defers shutdown through active and queued work until the final entry settles', () => {
    const activeKey = `active-${crypto.randomUUID()}`
    const queuedKey = `queued-${crypto.randomUUID()}`
    const decisions: boolean[] = []
    const removeListener = onRuntimeActivityChange(activityCount => {
      decisions.push(
        shouldDeferRuntimeIdleShutdown({
          leaseCount: 0,
          activityCount,
          shuttingDown: false,
        })
      )
    })

    try {
      retainRuntimeActivity(activeKey)
      retainRuntimeActivity(queuedKey)
      releaseRuntimeActivity(activeKey)
      expect(runtimeActivityCount()).toBeGreaterThan(0)
      releaseRuntimeActivity(queuedKey)

      expect(decisions).toEqual([true, true, true, false])
    } finally {
      releaseRuntimeActivity(activeKey)
      releaseRuntimeActivity(queuedKey)
      removeListener()
    }
  })
})
