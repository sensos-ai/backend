import type { ProviderV4 } from '@ai-sdk/provider'
import { createProviderRegistry } from 'ai'
import {
  createGatewayHarnessProvider,
  type VercelCredential,
} from './gateway'
import { createCodexHarnessProvider, type CodexCredential } from './openai'
import type { CredentialOf } from './harness-provider'

export type HarnessProviderCredentialsInput = {
  gateway?: VercelCredential
  codex?: CodexCredential
}

export type ProviderDependencies = {
  gateway?: Parameters<typeof createGatewayHarnessProvider>[1]
  codex?: Parameters<typeof createCodexHarnessProvider>[1]
}

export function createHarnessProviderRegistry(
  credentials: HarnessProviderCredentialsInput = {},
  dependencies: ProviderDependencies = {}
) {
  return {
    gateway: createGatewayHarnessProvider(
      credentials.gateway,
      dependencies.gateway
    ),
    codex: createCodexHarnessProvider(
      credentials.codex,
      dependencies.codex
    ),
  } as const
}

export type HarnessProviderRegistry = ReturnType<
  typeof createHarnessProviderRegistry
>
export type ModelProvider = keyof HarnessProviderRegistry
export type RegisteredHarnessProvider =
  HarnessProviderRegistry[ModelProvider]
export type ProviderCredentials = {
  [K in ModelProvider]?: CredentialOf<HarnessProviderRegistry[K]>
}

export function createAiProviderRegistry(
  harness: HarnessProviderRegistry
) {
  const providers = Object.fromEntries(
    Object.entries(harness).map(([id, entry]) => [id, entry.provider])
  ) as {
    [K in keyof HarnessProviderRegistry]: HarnessProviderRegistry[K]['provider'] &
      ProviderV4
  }
  return createProviderRegistry(providers)
}
