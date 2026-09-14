import type { GatewayProvider } from '@ai-sdk/gateway'
import type { ModelProvider, ProviderProfile } from '@/auth/profile'
import { readProviderProfile } from '@/auth/profile'
import { aiGateway, getGatewayModels } from './gateway'
import { getCodexModels, type ModelCatalogFetch } from './openai'
import { modelRefForProvider, type ModelRef } from './model'

export type AvailableModel = {
  id: string
  name: string
  description?: string
  priority?: number
}

export interface ModelCatalog {
  listModels(): Promise<AvailableModel[]>
}

type ModelCatalogRegistry = Record<ModelProvider, ModelCatalog>

export const GATEWAY_MODEL_PROVIDERS = new Set([
  'anthropic',
  'openai',
  'moonshotai',
  'spacexai',
])

export function gatewayModelCatalog(
  gateway: GatewayProvider = aiGateway()
): ModelCatalog {
  return {
    async listModels() {
      const { models } = await getGatewayModels(gateway)
      return models
        .filter(
          model =>
            model.modelType == null || model.modelType === 'language'
        )
        .filter(model =>
          GATEWAY_MODEL_PROVIDERS.has(model.id.split('/', 1)[0] ?? '')
        )
        .map(model => ({
          id: model.id,
          name: model.id,
          ...(model.description ? { description: model.description } : {}),
        }))
    },
  }
}

export function codexModelCatalog(
  profile: ProviderProfile,
  fetchImpl: ModelCatalogFetch = fetch
): ModelCatalog {
  return {
    async listModels() {
      const credential = profile.codex
      if (!credential) {
        throw new Error(
          'Codex is not connected. Run `sensos login codex` first.'
        )
      }
      return getCodexModels(credential, fetchImpl)
    },
  }
}

export function createModelCatalogRegistry(
  profile: ProviderProfile,
  overrides: Partial<ModelCatalogRegistry> = {}
): ModelCatalogRegistry {
  return {
    gateway: overrides.gateway ?? gatewayModelCatalog(),
    codex: overrides.codex ?? codexModelCatalog(profile),
  }
}

export async function listModelsForActiveProvider(
  dependencies: {
    readProfile?: () => Promise<ProviderProfile>
    createRegistry?: (profile: ProviderProfile) => ModelCatalogRegistry
  } = {}
): Promise<Array<AvailableModel & { ref: ModelRef }>> {
  const profile = await (dependencies.readProfile ?? readProviderProfile)()
  const registry = (
    dependencies.createRegistry ?? createModelCatalogRegistry
  )(profile)
  return (await registry[profile.activeProvider].listModels()).map(
    model => ({
      ...model,
      ref: modelRefForProvider(profile.activeProvider, model.id),
    })
  )
}
