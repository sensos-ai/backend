import type { LanguageModelV4, ProviderV4 } from '@ai-sdk/provider'

export interface HarnessModel<ModelId extends string = string> {
  id: ModelId
  name: string
  description?: string
  priority?: number
}

export type OptionalArgument<T> = [T] extends [undefined]
  ? []
  : [options: T]

export interface HarnessAuth<
  Credential,
  LoginOptions = undefined,
  User = unknown,
> {
  login(...args: OptionalArgument<LoginOptions>): Promise<Credential>
  logout?(
    credential: Credential,
    options?: { revoke?: boolean }
  ): Promise<void>
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
  ListOptions = undefined,
  LoginOptions = undefined,
  User = unknown,
> {
  sensosId: Id
  authKey: AuthKey
  provider: Provider
  defaultModelId: ModelId
  listModels(
    ...args: OptionalArgument<ListOptions>
  ): Promise<readonly Model[]>
  auth: HarnessAuth<Credential, LoginOptions, User>
}

export class SensosHarnessProvider<
  const Id extends string,
  const AuthKey extends string,
  Provider extends ProviderV4,
  ModelId extends string,
  Model extends HarnessModel<ModelId>,
  Credential,
  ListOptions = undefined,
  LoginOptions = undefined,
  User = unknown,
> {
  readonly sensosId: Id
  readonly authKey: AuthKey
  readonly provider: Provider
  readonly defaultModelId: ModelId
  readonly auth: HarnessAuth<Credential, LoginOptions, User>
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
      ListOptions,
      LoginOptions,
      User
    >
  ) {
    this.sensosId = options.sensosId
    this.authKey = options.authKey
    this.provider = options.provider
    this.defaultModelId = options.defaultModelId
    this.auth = options.auth
    this.fetchModels = options.listModels
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

export type ModelIdOf<Provider> =
  Provider extends SensosHarnessProvider<
    string,
    string,
    ProviderV4,
    infer ModelId,
    HarnessModel<any>,
    unknown,
    unknown,
    unknown,
    unknown
  >
    ? ModelId
    : never

export type CredentialOf<Provider> =
  Provider extends SensosHarnessProvider<
    string,
    string,
    ProviderV4,
    string,
    HarnessModel<string>,
    infer Credential,
    unknown,
    unknown,
    unknown
  >
    ? Credential
    : never

export type AuthKeyOf<Provider> =
  Provider extends SensosHarnessProvider<
    string,
    infer AuthKey,
    ProviderV4,
    string,
    HarnessModel<string>,
    unknown,
    unknown,
    unknown,
    unknown
  >
    ? AuthKey
    : never
