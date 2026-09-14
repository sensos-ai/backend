import type { GatewayModelId } from 'ai'
import { z } from 'zod'
import type { ModelIdOf } from './harness-provider'
import type { HarnessProviderRegistry, ModelProvider } from './registry'
import type { CodexModelId } from './openai'

export type ModelRef = {
  [ProviderId in ModelProvider]: {
    provider: ProviderId
    modelId: ModelIdOf<HarnessProviderRegistry[ProviderId]>
  }
}[ModelProvider]

export const modelRefSchema = z.discriminatedUnion('provider', [
  z.object({
    provider: z.literal('gateway'),
    modelId: z.custom<GatewayModelId>(
      value => typeof value === 'string' && value.length > 0
    ),
  }),
  z.object({
    provider: z.literal('codex'),
    modelId: z.custom<CodexModelId>(
      value => typeof value === 'string' && value.length > 0
    ),
  }),
])

export function modelRefForProvider<ProviderId extends ModelProvider>(
  provider: ProviderId,
  modelId: ModelIdOf<HarnessProviderRegistry[ProviderId]>
): Extract<ModelRef, { provider: ProviderId }> {
  return modelRefSchema.parse({ provider, modelId }) as Extract<
    ModelRef,
    { provider: ProviderId }
  >
}

export function normalizeLegacyModelRef(
  value: ModelRef | string | undefined
): ModelRef | undefined {
  if (!value) return undefined
  if (typeof value !== 'string') return modelRefSchema.parse(value)
  return value.includes('/')
    ? modelRefForProvider('gateway', value as GatewayModelId)
    : modelRefForProvider('codex', value as CodexModelId)
}
