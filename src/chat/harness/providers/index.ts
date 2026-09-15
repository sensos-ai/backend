import { customProvider, type GatewayModelId } from 'ai'
import type { ProviderOptions as AIProviderOptions } from '@ai-sdk/provider-utils'
import type {
  LanguageModelV4,
  LanguageModelV4Middleware,
} from '@ai-sdk/provider'
import { aiEmitter } from '@/shared/events'
import {
  readFreshProviderProfile,
  type readProviderProfile,
  readProviderProfileSync,
} from '@/auth/profile'
import { createGatewayOptions, DEFAULT_MODEL } from './gateway'
import {
  CODEX_DEFAULT_MODEL,
  createOpenaiOptions,
  type CodexModelId,
} from './openai'
import {
  createAiProviderRegistry,
  createHarnessProviderRegistry,
  type HarnessProviderRegistry,
  type ModelProvider,
  type ProviderDependencies,
} from './registry'
import { createTestLanguageModel } from './test-model'
import { modelRefForProvider, type ModelRef } from './model'

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
  provider: ModelProvider = readProviderProfileSync().activeProvider
) {
  const newOpts: ProviderOptions = {
    ...opts,
    gateway: createGatewayOptions(opts.gateway),
    openai: createOpenaiOptions(provider === 'codex', opts.openai),
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

export function defaultModelRef(provider: ModelProvider): ModelRef {
  return provider === 'codex'
    ? modelRefForProvider('codex', CODEX_DEFAULT_MODEL)
    : modelRefForProvider('gateway', DEFAULT_MODEL)
}

export function resolveModel(
  providers: HarnessProviderRegistry,
  ref: ModelRef
): LanguageModelV4 {
  switch (ref.provider) {
    case 'gateway':
      return providers.gateway.model(ref.modelId)
    case 'codex':
      return providers.codex.model(ref.modelId)
  }
}

export async function providerRegistry(
  dependencies: ProviderDependencies = {},
  provider?: ModelProvider
) {
  const profile = await readFreshProviderProfile(
    provider,
    undefined,
    dependencies
  )
  const harness = createHarnessProviderRegistry(
    profile.credentials,
    dependencies
  )
  const registry = createAiProviderRegistry(harness)
  const mockProvider = customProvider({
    languageModels: { default: createTestLanguageModel() },
  })
  return {
    harness,
    registry,
    testModel: mockProvider.languageModel('default'),
    gateway: (modelId: GatewayModelId = DEFAULT_MODEL) =>
      harness.gateway.model(modelId),
    codex: (modelId: CodexModelId = CODEX_DEFAULT_MODEL) =>
      harness.codex.model(modelId),
    resolveModel(modelRef?: ModelRef) {
      const ref = modelRef ?? defaultModelRef(profile.activeProvider)
      return {
        provider: ref.provider,
        model: resolveModel(harness, ref),
      }
    },
    activeProvider: profile.activeProvider,
  }
}

export async function languageModelForRef(modelRef?: ModelRef) {
  return (await providerRegistry({}, modelRef?.provider)).resolveModel(
    modelRef
  )
}

export async function listModelsForActiveProvider(
  dependencies: {
    readProfile?: typeof readProviderProfile
    createRegistry?: typeof createHarnessProviderRegistry
  } = {}
) {
  const profile = dependencies.readProfile
    ? await dependencies.readProfile()
    : await readFreshProviderProfile()
  const providers = (
    dependencies.createRegistry ?? createHarnessProviderRegistry
  )(profile.credentials)
  switch (profile.activeProvider) {
    case 'gateway':
      return (await providers.gateway.listModels()).map(model => ({
        ...model,
        ref: modelRefForProvider('gateway', model.id),
      }))
    case 'codex':
      return (await providers.codex.listModels()).map(model => ({
        ...model,
        ref: modelRefForProvider('codex', model.id),
      }))
  }
}

export type { CodexModelId } from './openai'
export { CODEX_DEFAULT_MODEL } from './openai'
export type { ModelProvider } from './registry'
export type { ModelRef } from './model'
export { modelRefForProvider } from './model'
export {
  createAiProviderRegistry,
  createHarnessAuthRegistry,
  createHarnessProviderRegistry,
  harnessAuthKeys,
  harnessAuthMetadata,
} from './registry'
export type {
  HarnessAuthKey,
  HarnessAuthMetadata,
  HarnessAuthStrategies,
} from './registry'
export {
  SensosHarnessProvider,
  type ApiKeyAuthStrategy,
  type AuthStrategy,
  type AuthStrategyName,
  type DeviceAuthStrategy,
  type HarnessAuth,
  type HarnessLoginOptions,
  type HarnessModel,
  type HarnessUser,
  type PKCEAuthStrategy,
} from './harness-provider'
