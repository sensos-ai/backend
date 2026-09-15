import type { ProviderV4 } from '@ai-sdk/provider'
import { createProviderRegistry } from 'ai'
import {
  createGatewayHarnessProvider,
  type VercelCredential,
} from './gateway'
import { createCodexHarnessProvider, type CodexCredential } from './openai'
import type {
  AuthKeyOf,
  AuthStrategiesOf,
  CredentialOf,
} from './harness-provider'

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
export type HarnessAuthKey = AuthKeyOf<RegisteredHarnessProvider>
export type HarnessAuthRegistry = {
  [Provider in RegisteredHarnessProvider as Provider['authKey']]: Provider
}
export type ProviderCredentials = {
  [K in ModelProvider]?: CredentialOf<HarnessProviderRegistry[K]>
}
export type HarnessAuthStrategies = {
  [K in HarnessAuthKey]: AuthStrategiesOf<HarnessAuthRegistry[K]>
}

export type HarnessAuthMetadata = {
  [K in HarnessAuthKey]: {
    displayName: HarnessAuthRegistry[K]['displayName']
    supportedAuthStrategies: HarnessAuthStrategies[K]
    defaultAuthStrategy: HarnessAuthRegistry[K]['defaultAuthStrategy']
    apiKeyEnvironmentVariable?: string
  }
}

export function createHarnessAuthRegistry(
  harness: HarnessProviderRegistry
): HarnessAuthRegistry {
  return Object.fromEntries(
    Object.values(harness).map(provider => [provider.authKey, provider])
  ) as HarnessAuthRegistry
}

export function harnessAuthKeys(
  harness: HarnessProviderRegistry
): HarnessAuthKey[] {
  return Object.keys(
    createHarnessAuthRegistry(harness)
  ) as HarnessAuthKey[]
}

export function harnessAuthMetadata(
  harness: HarnessProviderRegistry
): HarnessAuthMetadata {
  const auth = createHarnessAuthRegistry(harness)
  return Object.fromEntries(
    Object.entries(auth).map(([key, provider]) => [
      key,
      {
        displayName: provider.displayName,
        supportedAuthStrategies: provider.supportedAuthStrategies,
        defaultAuthStrategy: provider.defaultAuthStrategy,
        ...(provider.apiKeyEnvironmentVariable
          ? {
              apiKeyEnvironmentVariable:
                provider.apiKeyEnvironmentVariable,
            }
          : {}),
      },
    ])
  ) as HarnessAuthMetadata
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
