import type { LanguageModelV4, ProviderV4 } from '@ai-sdk/provider'

export interface HarnessModel<ModelId extends string = string> {
  id: ModelId
  name: string
  description?: string
  priority?: number
}

export interface HarnessUser {
  name: string
  email: string
  affiliation?: {
    kind: 'team' | 'organization'
    name: string
  }
}

export type AuthStrategyName = 'oauth-device' | 'oauth-pkce' | 'apiKey'

export type PKCEAuthStrategy = { type: 'oauth-pkce' }
export type DeviceAuthStrategy = { type: 'oauth-device' }
export type ApiKeyAuthStrategy = { type: 'apiKey'; apiKey?: string }
export type AuthStrategy =
  | PKCEAuthStrategy
  | DeviceAuthStrategy
  | ApiKeyAuthStrategy

export type HarnessLoginOptions<
  Strategy extends AuthStrategy = AuthStrategy,
> = {
  strategy: Strategy
  signal: AbortSignal
}

export type OAuthCredential = { kind: 'oauth'; expiresAt: number }

type StrategyFor<Names extends readonly AuthStrategyName[]> = Extract<
  AuthStrategy,
  { type: Names[number] }
>
export type OptionalArgument<T> = [T] extends [undefined]
  ? []
  : [options: T]

export interface HarnessAuth<
  Credential,
  Strategies extends readonly AuthStrategyName[],
  User = unknown,
> {
  isCredential(value: unknown): value is Credential
  login(
    options: HarnessLoginOptions<StrategyFor<Strategies>>
  ): Promise<Credential>
  needsRefresh(
    credential: Credential
  ): credential is Extract<Credential, OAuthCredential>
  logout?(
    credential: Credential,
    options?: { revoke?: boolean }
  ): Promise<void>
  refresh?(
    credential: Extract<Credential, OAuthCredential>
  ): Promise<Extract<Credential, OAuthCredential>>
  user?(credential: Credential): Promise<User>
  token?(credential: Credential): Promise<string>
}

export interface HarnessProviderOptions<
  Id extends string,
  AuthKey extends string,
  Provider extends ProviderV4,
  ModelId extends string,
  Model extends HarnessModel<ModelId>,
  Credential,
  Strategies extends readonly [AuthStrategyName, ...AuthStrategyName[]],
  ListOptions = undefined,
  User = unknown,
> {
  sensosId: Id
  authKey: AuthKey
  displayName: string
  supportedAuthStrategies: Strategies
  defaultAuthStrategy: Strategies[number]
  apiKeyEnvironmentVariable?: string
  provider: Provider
  defaultModelId: ModelId
  listModels(
    ...args: OptionalArgument<ListOptions>
  ): Promise<readonly Model[]>
  auth: HarnessAuth<Credential, Strategies, User>
}

export class SensosHarnessProvider<
  const Id extends string,
  const AuthKey extends string,
  Provider extends ProviderV4,
  ModelId extends string,
  Model extends HarnessModel<ModelId>,
  Credential,
  const Strategies extends readonly [
    AuthStrategyName,
    ...AuthStrategyName[],
  ],
  ListOptions = undefined,
  User = unknown,
> {
  declare readonly _types: {
    modelId: ModelId
    credential: Credential
    strategies: Strategies
  }
  readonly sensosId: Id
  readonly authKey: AuthKey
  readonly displayName: string
  readonly supportedAuthStrategies: Strategies
  readonly defaultAuthStrategy: Strategies[number]
  readonly apiKeyEnvironmentVariable?: string
  readonly provider: Provider
  readonly defaultModelId: ModelId
  readonly auth: HarnessAuth<Credential, Strategies, User>
  private readonly fetchModels: (
    ...args: OptionalArgument<ListOptions>
  ) => Promise<readonly Model[]>

  constructor(
    options: HarnessProviderOptions<
      Id,
      AuthKey,
      Provider,
      ModelId,
      Model,
      Credential,
      Strategies,
      ListOptions,
      User
    >
  ) {
    this.sensosId = options.sensosId
    this.authKey = options.authKey
    this.displayName = options.displayName
    this.supportedAuthStrategies = options.supportedAuthStrategies
    this.defaultAuthStrategy = options.defaultAuthStrategy
    this.apiKeyEnvironmentVariable = options.apiKeyEnvironmentVariable
    this.provider = options.provider
    this.defaultModelId = options.defaultModelId
    this.fetchModels = options.listModels
    const strategies = new Set(options.supportedAuthStrategies)
    if (strategies.size !== options.supportedAuthStrategies.length) {
      throw new Error(
        `${options.displayName} declares duplicate auth strategies.`
      )
    }
    if (!strategies.has(options.defaultAuthStrategy)) {
      throw new Error(
        `${options.displayName} default auth strategy is unsupported.`
      )
    }
    if (strategies.has('apiKey') && !options.apiKeyEnvironmentVariable) {
      throw new Error(
        `${options.displayName} must declare an API-key environment variable.`
      )
    }
    this.auth = {
      ...options.auth,
      login: async loginOptions => {
        if (!strategies.has(loginOptions.strategy.type)) {
          throw new Error(
            `${options.displayName} does not support this login strategy, available methods are: ${options.supportedAuthStrategies.join(', ')}`
          )
        }
        return await options.auth.login(loginOptions)
      },
    }
  }

  model(modelId: ModelId = this.defaultModelId): LanguageModelV4 {
    return this.provider.languageModel(modelId)
  }

  listModels(
    ...args: OptionalArgument<ListOptions>
  ): Promise<readonly Model[]> {
    return this.fetchModels(...args)
  }
}

export type ModelIdOf<Provider> = Provider extends {
  readonly _types: { modelId: infer ModelId }
}
  ? ModelId
  : never

export type CredentialOf<Provider> = Provider extends {
  readonly _types: { credential: infer Credential }
}
  ? Credential
  : never

export type AuthKeyOf<Provider> = Provider extends {
  readonly authKey: infer AuthKey extends string
}
  ? AuthKey
  : never

export type AuthStrategiesOf<Provider> = Provider extends {
  readonly _types: { strategies: infer Strategies }
}
  ? Strategies
  : never
