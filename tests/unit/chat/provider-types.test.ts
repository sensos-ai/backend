import { expect, expectTypeOf, test } from 'bun:test'
import type { GatewayModelId } from 'ai'
import type {
  HarnessAuthKey,
  HarnessAuthRegistry,
  HarnessProviderRegistry,
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
})

test('authentication aliases are derived from provider metadata', () => {
  const providers = createHarnessProviderRegistry()
  const auth = createHarnessAuthRegistry(providers)

  expect(harnessAuthKeys(providers)).toEqual(['vercel', 'codex'])
  expect(auth.vercel).toBe(providers.gateway)
  expect(auth.codex).toBe(providers.codex)
})
