import type {
  LanguageModelV4FinishReason,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
  SharedV4ProviderMetadata,
} from '@ai-sdk/provider'

export const scriptedUsage: LanguageModelV4Usage = {
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
}

export type ScriptedRequestExpectation = {
  modelId?: string
  promptContains?: string
  promptExcludes?: string
  toolResult?: { toolCallId: string; toolName?: string }
}

export type ScriptedChunk =
  | LanguageModelV4StreamPart
  | { type: 'hold'; gate: string }
  | { type: 'throw'; message: string }
  | { type: 'malformed'; data?: string }

export type ScriptedTurn = {
  expect?: ScriptedRequestExpectation
  chunks: ScriptedChunk[]
  required?: boolean
}

export type ScriptedScenario = {
  name: string
  turns: ScriptedTurn[]
}

export function textTurn(
  text: string,
  options: {
    expect?: ScriptedRequestExpectation
    id?: string
    finishReason?: LanguageModelV4FinishReason
    providerMetadata?: SharedV4ProviderMetadata
  } = {}
): ScriptedTurn {
  const id = options.id ?? 'text-1'
  return {
    expect: options.expect,
    chunks: [
      { type: 'text-start', id },
      { type: 'text-delta', id, delta: text },
      { type: 'text-end', id },
      {
        type: 'finish',
        finishReason:
          options.finishReason ??
          ({ unified: 'stop', raw: 'stop' } as const),
        usage: scriptedUsage,
        providerMetadata: options.providerMetadata,
      },
    ],
  }
}
