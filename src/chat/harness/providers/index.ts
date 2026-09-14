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
import type { ModelProvider } from '@/auth/profile'
import type { CodexModelId, ModelRef } from './model'

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

export function createProviderOptions(
  opts: ProviderOptions = {},
  provider = readProviderProfileSync().activeProvider
) {
  const isCodex = provider === 'codex'

  const newOpts: ProviderOptions = {
    ...opts,
    gateway: createGatewayOptions(opts.gateway),
    openai: createOpenaiOptions(isCodex, opts.openai),
  }
  return newOpts as AIProviderOptions
}

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

export function defaultModelRef(provider: ModelProvider): ModelRef {
  return provider === 'codex'
    ? { provider, modelId: CODEX_DEFAULT_MODEL }
    : { provider, modelId: DEFAULT_MODEL }
}

function codexModelId(modelId?: CodexModelId): string {
  if (!modelId) return CODEX_DEFAULT_MODEL
  return modelId
}

export function providerRegistry(config?: ProviderRegistryConfig) {
  const profile = readProviderProfileSync()
  const mockProvider = customProvider({
    languageModels: {
      default: createTestLanguageModel(),
    },
  })

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
  const gateway = (modelId: GatewayModelId = DEFAULT_MODEL) =>
    registry.languageModel(`gateway:${modelId}`)
  const codexModel = (modelId?: CodexModelId) =>
    registry.languageModel(`codex:${codexModelId(modelId)}`)
  const resolveModel = (modelRef?: ModelRef) => {
    const ref = modelRef ?? defaultModelRef(profile.activeProvider)
    return {
      provider: ref.provider,
      model:
        ref.provider === 'codex'
          ? codexModel(ref.modelId)
          : gateway(ref.modelId),
    }
  }

  return {
    registry,
    testModel: registry.languageModel('test:default'),
    gateway,
    codex: codexModel,
    resolveModel,
    activeProvider: profile.activeProvider,
  }
}

export function languageModelForRef(modelRef?: ModelRef) {
  return providerRegistry().resolveModel(modelRef)
}

export type { CodexModelId, ModelRef } from './model'
