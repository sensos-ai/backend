import { expect, expectTypeOf, test } from 'bun:test'
import type { GatewayModelId } from 'ai'
import type {
  HarnessAuthKey,
  HarnessAuthRegistry,
  HarnessProviderRegistry,
  HarnessAuthStrategies,
  ModelProvider,
  ProviderCredentials,
} from '@/chat/harness/providers/registry'
import type { ModelRef } from '@/chat/harness/providers/model'
import type { CodexCredential } from '@/chat/harness/providers/openai'
import type { VercelCredential } from '@/chat/harness/providers/gateway'
import {
  createHarnessAuthRegistry,
  createHarnessProviderRegistry,
  harnessAuthKeys,
  harnessAuthMetadata,
} from '@/chat/harness/providers/registry'

test('provider, model, and credential types are inferred from the registry', () => {
  expectTypeOf<ModelProvider>().toEqualTypeOf<'gateway' | 'codex'>()
  expectTypeOf<HarnessAuthKey>().toEqualTypeOf<'vercel' | 'codex'>()
  expectTypeOf<
    HarnessAuthRegistry['vercel']['sensosId']
  >().toEqualTypeOf<'gateway'>()
  expectTypeOf<
    Extract<ModelRef, { provider: 'gateway' }>['modelId']
  >().toMatchTypeOf<GatewayModelId>()
  expectTypeOf<
    Extract<ModelRef, { provider: 'codex' }>['modelId']
  >().toMatchTypeOf<string>()
  expectTypeOf<
    NonNullable<ProviderCredentials['gateway']>
  >().toEqualTypeOf<VercelCredential>()
  expectTypeOf<
    NonNullable<ProviderCredentials['codex']>
  >().toEqualTypeOf<CodexCredential>()
  expectTypeOf<
    keyof HarnessProviderRegistry
  >().toEqualTypeOf<ModelProvider>()
  expectTypeOf<HarnessAuthStrategies['codex']>().toEqualTypeOf<
    readonly ['oauth-pkce', 'oauth-device']
  >()
  expectTypeOf<HarnessAuthStrategies['vercel']>().toEqualTypeOf<
    readonly ['oauth-device', 'apiKey']
  >()
})

test('authentication aliases are derived from provider metadata', () => {
  const providers = createHarnessProviderRegistry()
  const auth = createHarnessAuthRegistry(providers)

  expect(harnessAuthKeys(providers)).toEqual(['vercel', 'codex'])
  expect(auth.vercel).toBe(providers.gateway)
  expect(auth.codex).toBe(providers.codex)
  expect(harnessAuthMetadata(providers)).toEqual({
    vercel: {
      displayName: 'Vercel AI Gateway',
      supportedAuthStrategies: ['oauth-device', 'apiKey'],
      defaultAuthStrategy: 'oauth-device',
      apiKeyEnvironmentVariable: 'AI_GATEWAY_API_KEY',
    },
    codex: {
      displayName: 'OpenAI Codex',
      supportedAuthStrategies: ['oauth-pkce', 'oauth-device'],
      defaultAuthStrategy: 'oauth-pkce',
    },
  })
})

test('provider login types reject unsupported strategies', () => {
  const providers = createHarnessProviderRegistry()
  const rejectUnsupportedStrategiesAtCompileTime = () => {
    providers.codex.auth.login({
      // @ts-expect-error Codex does not support API-key authentication.
      strategy: { type: 'apiKey', apiKey: 'secret' },
      signal: AbortSignal.abort(),
    })
    providers.gateway.auth.login({
      // @ts-expect-error Gateway does not support PKCE authentication.
      strategy: { type: 'oauth-pkce' },
      signal: AbortSignal.abort(),
    })
  }
  expectTypeOf(rejectUnsupportedStrategiesAtCompileTime).toBeFunction()
})
