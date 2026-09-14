import type { GatewayModelId } from 'ai'
import { z } from 'zod'
import type { ModelProvider } from '@/auth/profile'

export type CodexModelId = `gpt-${string}` | (string & {})

export type ModelRef =
  | { provider: 'gateway'; modelId: GatewayModelId }
  | { provider: 'codex'; modelId: CodexModelId }

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
  return modelRefForProvider(
    value.includes('/') ? 'gateway' : 'codex',
    value
  )
}
