import type { GatewayModelId } from 'ai'
import {
  modelRefSchema,
  type ModelProvider,
  type ModelRef,
} from '@sensos-ai/shared'
import type { CodexModelId } from './openai'

export { modelRefSchema }
export type { ModelProvider, ModelRef }

export function modelRefForProvider(
  provider: ModelProvider,
  modelId: string
): ModelRef {
  return modelRefSchema.parse({ provider, modelId })
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
