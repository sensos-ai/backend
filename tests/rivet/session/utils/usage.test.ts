import { describe, expect, test } from 'bun:test'
import type { RunStepMetadata } from '@/runtime/actors/session/db'
import { aggregateUsage } from '@/runtime/actors/session/utils/usage'

describe('aggregateUsage', () => {
  test('keeps empty usage undefined', () => {
    expect(aggregateUsage([])).toEqual({
      inputTokens: undefined,
      inputTokenDetails: {
        noCacheTokens: undefined,
        cacheReadTokens: undefined,
        cacheWriteTokens: undefined,
      },
      outputTokens: undefined,
      outputTokenDetails: {
        textTokens: undefined,
        reasoningTokens: undefined,
      },
      totalTokens: undefined,
    })
  })

  test('adds defined token counts', () => {
    const usage = {
      inputTokens: 2,
      inputTokenDetails: {
        noCacheTokens: 1,
        cacheReadTokens: 1,
        cacheWriteTokens: undefined,
      },
      outputTokens: 3,
      outputTokenDetails: { textTokens: 2, reasoningTokens: 1 },
      totalTokens: 5,
    }
    const step = { usage } as RunStepMetadata
    expect(aggregateUsage([step, step]).totalTokens).toBe(10)
    expect(
      aggregateUsage([step, step]).inputTokenDetails.cacheWriteTokens
    ).toBeUndefined()
  })
})
