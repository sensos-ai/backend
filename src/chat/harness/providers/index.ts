import { customProvider, type GatewayModelId } from 'ai'
import type { ProviderOptions as AIProviderOptions } from '@ai-sdk/provider-utils'
import type {
  LanguageModelV4,
  LanguageModelV4Middleware,
} from '@ai-sdk/provider'
import { aiEmitter } from '@/shared/events'
import { aiGateway, createGatewayOptions, DEFAULT_MODEL } from './gateway'
import {
  codex,
  CODEX_DEFAULT_MODEL,
  createOpenaiOptions,
  type CodexModelId,
} from './openai'
import { createTestLanguageModel } from './test-model'
import {
  modelRefForProvider,
  type ModelProvider,
  type ModelRef,
} from './model'

export type ProviderOptions = {
  gateway?: Parameters<typeof createGatewayOptions>[0]
  openai?: Parameters<typeof createOpenaiOptions>[1]
}

export function createProviderOptions(
  opts: ProviderOptions = {},
  provider: ModelProvider = 'gateway'
) {
  return {
    ...opts,
    gateway: createGatewayOptions(opts.gateway),
    openai: createOpenaiOptions(provider === 'codex', opts.openai),
  } as AIProviderOptions
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

export function defaultModelRef(provider: ModelProvider): ModelRef {
  return provider === 'codex'
    ? modelRefForProvider('codex', CODEX_DEFAULT_MODEL)
    : modelRefForProvider('gateway', DEFAULT_MODEL)
}

export function providerRegistry() {
  const gatewayProvider = aiGateway()
  const codexProvider = codex()
  const mockProvider = customProvider({
    languageModels: { default: createTestLanguageModel() },
  })
  return {
    testModel: mockProvider.languageModel('default'),
    gateway: (modelId: GatewayModelId = DEFAULT_MODEL) =>
      gatewayProvider.languageModel(modelId),
    codex: (modelId: CodexModelId = CODEX_DEFAULT_MODEL) =>
      codexProvider.languageModel(modelId),
    resolveModel(modelRef?: ModelRef): {
      provider: ModelProvider
      model: LanguageModelV4
    } {
      const ref = modelRef ?? defaultModelRef('gateway')
      return {
        provider: ref.provider,
        model:
          ref.provider === 'codex'
            ? codexProvider.languageModel(ref.modelId as CodexModelId)
            : gatewayProvider.languageModel(ref.modelId as GatewayModelId),
      }
    },
  }
}

export async function languageModelForRef(modelRef?: ModelRef) {
  return providerRegistry().resolveModel(modelRef)
}

export type { CodexModelId } from './openai'
export { CODEX_DEFAULT_MODEL } from './openai'
export type { ModelProvider, ModelRef } from './model'
export { modelRefForProvider } from './model'
