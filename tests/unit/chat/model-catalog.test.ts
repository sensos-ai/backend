import { describe, expect, test } from 'bun:test'
import type { GatewayProvider } from '@ai-sdk/gateway'
import { createGatewayHarnessProvider } from '@/chat/harness/providers/gateway'
import {
  createHarnessProviderRegistry,
  listModelsForActiveProvider,
} from '@/chat/harness/providers'
import {
  CODEX_MODEL_CLIENT_VERSION,
  CODEX_MODELS_URL,
  getCodexModels,
} from '@/chat/harness/providers/openai'
import type { ProviderProfile } from '@/auth/profile'
import { normalizeLegacyModelRef } from '@/chat/harness/providers/model'

const profile = {
  version: 3,
  activeProvider: 'codex',
  storagePreference: 'file',
  credentialBackends: { codex: 'file' },
  credentials: {
    codex: {
      kind: 'oauth',
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: 123,
      accountId: 'account-id',
    },
  },
} as const satisfies ProviderProfile

describe('provider model catalogs', () => {
  test('normalizes legacy model strings into provider-qualified refs', () => {
    expect(normalizeLegacyModelRef('openai/gpt-5.6-sol')).toEqual({
      provider: 'gateway',
      modelId: 'openai/gpt-5.6-sol',
    })
    expect(normalizeLegacyModelRef('gpt-5.6-sol')).toEqual({
      provider: 'codex',
      modelId: 'gpt-5.6-sol',
    })
  })

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

    expect(
      await createGatewayHarnessProvider(undefined, {
        provider: gateway,
      }).listModels()
    ).toEqual([
      { id: 'anthropic/claude', name: 'anthropic/claude' },
      { id: 'openai/gpt', name: 'openai/gpt' },
      { id: 'moonshotai/kimi', name: 'moonshotai/kimi' },
      { id: 'spacexai/grok', name: 'spacexai/grok' },
    ])
  })

  test('fetches visible API models with Codex authentication', async () => {
    let request: Request | undefined
    const models = await getCodexModels(
      profile.credentials.codex,
      async (input, init) => {
        request = new Request(input, init)
        return Response.json({
          models: [
            {
              slug: 'gpt-second',
              display_name: 'GPT Second',
              description: 'Second model',
              visibility: 'list',
              supported_in_api: true,
              priority: 2,
            },
            {
              slug: 'gpt-first',
              display_name: 'GPT First',
              description: 'First model',
              visibility: 'list',
              supported_in_api: true,
              priority: 1,
            },
            {
              slug: 'gpt-hidden',
              display_name: 'GPT Hidden',
              visibility: 'hide',
              supported_in_api: true,
              priority: 0,
            },
            {
              slug: 'gpt-unsupported',
              display_name: 'GPT Unsupported',
              visibility: 'list',
              supported_in_api: false,
              priority: 0,
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
        id: 'gpt-first',
        name: 'GPT First',
        description: 'First model',
        priority: 1,
      },
      {
        id: 'gpt-second',
        name: 'GPT Second',
        description: 'Second model',
        priority: 2,
      },
    ])
  })

  test('routes discovery through the active provider catalog', async () => {
    expect(
      await listModelsForActiveProvider({
        readProfile: async () => profile,
        createRegistry: credentials =>
          createHarnessProviderRegistry(credentials, {
            codex: {
              fetch: async () =>
                Response.json({
                  models: [
                    {
                      slug: 'codex-model',
                      display_name: 'Codex',
                      visibility: 'list',
                      supported_in_api: true,
                      priority: 1,
                    },
                  ],
                }),
            },
          }),
      })
    ).toEqual([
      {
        id: 'codex-model',
        name: 'Codex',
        priority: 1,
        ref: { provider: 'codex', modelId: 'codex-model' },
      },
    ])
  })
})
