import { describe, expect, test } from 'bun:test'
import type { GatewayProvider } from '@ai-sdk/gateway'
import {
  createModelCatalogRegistry,
  gatewayModelCatalog,
  listModelsForActiveProvider,
  type ModelCatalog,
} from '@/chat/harness/providers/model-catalog'
import {
  CODEX_MODEL_CLIENT_VERSION,
  CODEX_MODELS_URL,
  getCodexModels,
} from '@/chat/harness/providers/openai'
import type { ProviderProfile } from '@/auth/profile'

const profile = {
  version: 1,
  activeProvider: 'codex',
  codex: {
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    expiresAt: 123,
    accountId: 'account-id',
  },
} as const satisfies ProviderProfile

describe('provider model catalogs', () => {
  test('filters Gateway models to supported language model providers', async () => {
    const gateway = {
      getAvailableModels: async () => ({
        models: [
          { id: 'anthropic/claude', name: 'Claude', specification: {} },
          { id: 'openai/gpt', name: 'GPT', specification: {} },
          { id: 'moonshotai/kimi', name: 'Kimi', specification: {} },
          { id: 'spacexai/grok', name: 'Grok', specification: {} },
          { id: 'google/gemini', name: 'Gemini', specification: {} },
          {
            id: 'openai/embedding',
            name: 'Embedding',
            modelType: 'embedding',
            specification: {},
          },
        ],
      }),
    } as unknown as GatewayProvider

    expect(await gatewayModelCatalog(gateway).listModels()).toEqual([
      { id: 'anthropic/claude', name: 'anthropic/claude' },
      { id: 'openai/gpt', name: 'openai/gpt' },
      { id: 'moonshotai/kimi', name: 'moonshotai/kimi' },
      { id: 'spacexai/grok', name: 'spacexai/grok' },
    ])
  })

  test('fetches visible API models with Codex authentication', async () => {
    let request: Request | undefined
    const models = await getCodexModels(
      profile.codex,
      async (input, init) => {
        request = new Request(input, init)
        return Response.json({
          models: [
            {
              slug: 'gpt-visible',
              display_name: 'GPT Visible',
              description: 'Available model',
              visibility: 'list',
              supported_in_api: true,
            },
            {
              slug: 'gpt-hidden',
              display_name: 'GPT Hidden',
              visibility: 'hide',
            },
            {
              slug: 'gpt-unsupported',
              display_name: 'GPT Unsupported',
              supported_in_api: false,
            },
          ],
        })
      }
    )

    expect(request?.url).toBe(CODEX_MODELS_URL)
    expect(
      new URL(request?.url ?? '').searchParams.get('client_version')
    ).toBe(CODEX_MODEL_CLIENT_VERSION)
    expect(request?.headers.get('authorization')).toBe(
      'Bearer access-token'
    )
    expect(request?.headers.get('chatgpt-account-id')).toBe('account-id')
    expect(request?.headers.get('originator')).toBe('codex_cli_rs')
    expect(request?.headers.get('user-agent')).toBe(
      `codex_cli_rs/${CODEX_MODEL_CLIENT_VERSION}`
    )
    expect(models).toEqual([
      {
        id: 'gpt-visible',
        name: 'GPT Visible',
        description: 'Available model',
      },
    ])
  })

  test('routes discovery through the active provider catalog', async () => {
    const gateway: ModelCatalog = {
      listModels: async () => [{ id: 'gateway-model', name: 'Gateway' }],
    }
    const codex: ModelCatalog = {
      listModels: async () => [{ id: 'codex-model', name: 'Codex' }],
    }

    expect(
      await listModelsForActiveProvider({
        readProfile: async () => profile,
        createRegistry: current =>
          createModelCatalogRegistry(current, { gateway, codex }),
      })
    ).toEqual([{ id: 'codex-model', name: 'Codex' }])
  })
})
