import type { LanguageModelUsage } from 'ai'
import type { RunStepMetadata } from '../db'

export const addCount = (left?: number, right?: number) =>
  left == null && right == null ? undefined : (left ?? 0) + (right ?? 0)

export function aggregateUsage(
  steps: RunStepMetadata[]
): LanguageModelUsage {
  return steps.reduce<LanguageModelUsage>(
    (total, step) => ({
      inputTokens: addCount(total.inputTokens, step.usage.inputTokens),
      inputTokenDetails: {
        noCacheTokens: addCount(
          total.inputTokenDetails.noCacheTokens,
          step.usage.inputTokenDetails.noCacheTokens
        ),
        cacheReadTokens: addCount(
          total.inputTokenDetails.cacheReadTokens,
          step.usage.inputTokenDetails.cacheReadTokens
        ),
        cacheWriteTokens: addCount(
          total.inputTokenDetails.cacheWriteTokens,
          step.usage.inputTokenDetails.cacheWriteTokens
        ),
      },
      outputTokens: addCount(total.outputTokens, step.usage.outputTokens),
      outputTokenDetails: {
        textTokens: addCount(
          total.outputTokenDetails.textTokens,
          step.usage.outputTokenDetails.textTokens
        ),
        reasoningTokens: addCount(
          total.outputTokenDetails.reasoningTokens,
          step.usage.outputTokenDetails.reasoningTokens
        ),
      },
      totalTokens: addCount(total.totalTokens, step.usage.totalTokens),
    }),
    {
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
    }
  )
}
