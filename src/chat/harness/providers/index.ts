import {
  customProvider,
  createProviderRegistry,
  type GatewayModelId,
} from 'ai'
import type { ProviderOptions as AIProviderOptions } from '@ai-sdk/provider-utils'
import type { LanguageModelV4Middleware } from '@ai-sdk/provider'
import { codex, createOpenaiOptions } from './openai'
import { aiGateway, createGatewayOptions, DEFAULT_MODEL } from './gateway'
import { createTestLanguageModel } from './test-model'
import { aiEmitter } from '@/shared/events'
import { readProviderProfileSync } from '@/auth/profile'

type StrictUnion<T> = T extends any
  ? string extends T
    ? never
    : T
  : never

type StrictGatewayModelId = StrictUnion<GatewayModelId>

type ExtractProvider<
  T extends StrictGatewayModelId = StrictGatewayModelId,
> = T extends StrictGatewayModelId
  ? T extends `${infer Before}/${string}`
    ? Before
    : T
  : never

// Example usage:
export type AnyProvider = ExtractProvider
export type ProviderExclude<T extends AnyProvider> = Exclude<
  AnyProvider,
  T
>

export type ProviderOptions = {
  gateway?: Parameters<typeof createGatewayOptions>[0]
  openai?: Parameters<typeof createOpenaiOptions>[1]
} & {
  [K in ProviderExclude<'openai'>]?: AIProviderOptions[keyof AIProviderOptions]
}

export function createProviderOptions(opts: ProviderOptions = {}) {
  const isCodex = readProviderProfileSync().activeProvider === 'codex'

  const newOpts: ProviderOptions = {
    ...opts,
    gateway: createGatewayOptions(opts.gateway),
    openai: createOpenaiOptions(isCodex, opts.openai),
  }
  return newOpts as AIProviderOptions
}

const mockProvider = customProvider({
  languageModels: {
    default: createTestLanguageModel(),
  },
})

export const loggingMiddleware: LanguageModelV4Middleware = {
  specificationVersion: 'v4',
  wrapGenerate: async ({ doGenerate, model }) => {
    aiEmitter.emit('start', 'generate', {
      provider: model.provider,
      modelId: model.modelId,
    })
    return doGenerate()
  },
  wrapStream: async ({ doStream, model }) => {
    aiEmitter.emit('start', 'stream', {
      provider: model.provider,
      modelId: model.modelId,
    })
    return doStream()
  },
}

type ProviderRegistryConfig = {
  gateway?: Parameters<typeof aiGateway>[0]
  codex?: Parameters<typeof codex>[0]
}

export const CODEX_DEFAULT_MODEL = 'gpt-5.6-sol'

function codexModelId(modelId?: GatewayModelId): string {
  if (!modelId) return CODEX_DEFAULT_MODEL
  return modelId.startsWith('openai/')
    ? modelId.slice('openai/'.length)
    : modelId
}

export function providerRegistry(config?: ProviderRegistryConfig) {
  const profile = readProviderProfileSync()

  // setup registry with provider credentials
  const registry = createProviderRegistry({
    test: mockProvider,
    gateway: aiGateway(config?.gateway),
    codex: codex({
      ...(config?.codex ?? {}),
      apiKey: profile.codex?.accessToken,
      accountId: profile.codex?.accountId,
    }),
  })

  return {
    registry,
    testModel: registry.languageModel('test:default'),
    gateway: (modelId: GatewayModelId = DEFAULT_MODEL) =>
      registry.languageModel(`gateway:${modelId}`),
    codex: (modelId?: GatewayModelId) =>
      registry.languageModel(`codex:${codexModelId(modelId)}`),
    activeProvider: profile.activeProvider,
  }
}
