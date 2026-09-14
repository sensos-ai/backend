import { expectTypeOf, test } from 'bun:test'
import type { GatewayModelId } from 'ai'
import type {
  HarnessProviderRegistry,
  ModelProvider,
  ProviderCredentials,
} from '@/chat/harness/providers/registry'
import type { ModelRef } from '@/chat/harness/providers/model'
import type { CodexCredential } from '@/chat/harness/providers/openai'
import type { VercelCredential } from '@/chat/harness/providers/gateway'

test('provider, model, and credential types are inferred from the registry', () => {
  expectTypeOf<ModelProvider>().toEqualTypeOf<'gateway' | 'codex'>()
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
