import {
  generateText,
  streamText,
  type LanguageModel,
  type GatewayModelId,
  type UIMessage,
  wrapLanguageModel,
} from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import type { OpenAILanguageModelChatOptions } from '@ai-sdk/openai'
import type { HarnessFeatures } from '@/chat/harness'
import {
  CODEX_DEFAULT_MODEL,
  createProviderOptions,
  languageModelForRef,
  loggingMiddleware,
} from '@/chat/harness/providers'
import type { ModelProvider } from '@/auth/profile'
import { readProviderProfileSync } from '@/auth/profile'
import type { ModelRef } from '@/chat/harness/providers/model'

export const TITLE_MODEL: GatewayModelId = 'openai/gpt-5-nano'
const MAX_TITLE_LENGTH = 80
const MAX_TITLE_OUTPUT_TOKENS = 30

export function titleModelRef(provider: ModelProvider): ModelRef {
  return provider === 'codex'
    ? { provider, modelId: CODEX_DEFAULT_MODEL }
    : { provider, modelId: TITLE_MODEL }
}

export function titleMaxOutputTokens(
  provider: 'codex' | 'gateway'
): number | undefined {
  // ChatGPT's Codex endpoint rejects max_output_tokens. The gateway accepts
  // the limit, so keep title generation bounded wherever it is supported.
  return provider === 'codex' ? undefined : MAX_TITLE_OUTPUT_TOKENS
}

export function shouldGenerateSessionTitle(input: {
  created: boolean
  revision: number
  title?: string
}): boolean {
  return input.created && !input.title
}

export function userMessageText(message: UIMessage): string | undefined {
  if (message.role !== 'user') return undefined
  const text = message.parts
    .filter(part => part.type === 'text')
    .map(part => part.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text || undefined
}

export function normalizeSessionTitle(value: string): string | undefined {
  const title = value
    .trim()
    .replace(/^['"`]+|['"`]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!title) return undefined
  return title.slice(0, MAX_TITLE_LENGTH).trim()
}

function deterministicTitle(prompt: string): string {
  const words = prompt.replace(/\s+/g, ' ').trim().split(' ')
  return words.slice(0, 8).join(' ')
}

function titleTestModel(prompt: string): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text', text: deterministicTitle(prompt) }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: {
          total: 1,
          noCache: 1,
          cacheRead: undefined,
          cacheWrite: undefined,
        },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
      },
      warnings: [],
    }),
  })
}

export async function generateSessionTitle(
  prompt: string,
  options: {
    model?: LanguageModel
    provider?: ModelProvider
    features?: HarnessFeatures
  } = {}
): Promise<string | undefined> {
  if (options.model || options.features?.useMockModel) {
    const result = await generateText({
      model: options.model ?? titleTestModel(prompt),
      maxOutputTokens: MAX_TITLE_OUTPUT_TOKENS,
      instructions:
        'Create a concise title for this chat session. Return only the title, with no quotes or punctuation wrapper. Use at most 8 words.',
      prompt,
      providerOptions: {
        openai: {
          serviceTier: 'fast',
          reasoningEffort: 'none',
        } satisfies OpenAILanguageModelChatOptions,
      },
    })
    return normalizeSessionTitle(result.text)
  }

  const activeProvider =
    options.provider ?? readProviderProfileSync().activeProvider
  const resolved = languageModelForRef(titleModelRef(activeProvider))
  const model = wrapLanguageModel({
    model: resolved.model,
    middleware: loggingMiddleware,
  })

  if (activeProvider === 'codex') {
    const result = streamText({
      model,
      instructions:
        'Create a concise title for this chat session. Return only the title, with no quotes or punctuation wrapper. Use at most 8 words.',
      prompt,
      providerOptions: createProviderOptions({}, activeProvider),
    })
    return normalizeSessionTitle(await result.text)
  }

  const result = await generateText({
    model,
    maxOutputTokens: titleMaxOutputTokens(activeProvider),
    instructions:
      'Create a concise title for this chat session. Return only the title, with no quotes or punctuation wrapper. Use at most 8 words.',
    prompt,
    providerOptions: {
      openai: {
        serviceTier: 'fast',
        reasoningEffort: 'none',
      } satisfies OpenAILanguageModelChatOptions,
    },
  })
  return normalizeSessionTitle(result.text)
}
