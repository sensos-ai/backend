import {
  createOpenAI,
  type OpenAIResponsesProviderOptions,
} from '@ai-sdk/openai'
import { z } from 'zod'
import { loginWithCodex } from '@/auth/oauth/codex'
import {
  SensosHarnessProvider,
  type HarnessModel,
} from '../harness-provider'

export type CodexModelId = `gpt-${string}` | (string & {})

export type CodexCredential = {
  accessToken: string
  refreshToken: string
  expiresAt: number
  accountId: string
}

export interface CodexCatalogModel extends HarnessModel<CodexModelId> {
  priority: number
}

export type CodexLoginOptions = {
  openUrl: (url: string) => Promise<void>
  signal?: AbortSignal
}

export const CODEX_DEFAULT_MODEL: CodexModelId = 'gpt-5.6-sol'

export type ModelCatalogFetch = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>

// This endpoint uses the client version to gate the catalog schema and models.
// Bump this only when Sensos supports the corresponding Codex model contract.
export const CODEX_MODEL_CLIENT_VERSION = '0.145.0'
export const CODEX_MODELS_URL = `https://chatgpt.com/backend-api/codex/models?client_version=${CODEX_MODEL_CLIENT_VERSION}`

const codexModelsResponseSchema = z.object({
  models: z.array(
    z.object({
      slug: z.string(),
      display_name: z.string(),
      description: z.string().nullish(),
      visibility: z.string().optional(),
      supported_in_api: z.boolean().optional(),
      priority: z.number(),
    })
  ),
})

export async function getCodexModels(
  credential: CodexCredential,
  fetchImpl: ModelCatalogFetch = fetch
): Promise<CodexCatalogModel[]> {
  const response = await fetchImpl(CODEX_MODELS_URL, {
    headers: {
      Authorization: `Bearer ${credential.accessToken}`,
      'chatgpt-account-id': credential.accountId,
      originator: 'codex_cli_rs',
      'User-Agent': `codex_cli_rs/${CODEX_MODEL_CLIENT_VERSION}`,
      Accept: 'application/json',
    },
  })
  if (!response.ok) {
    throw new Error(
      `Could not load Codex models (${response.status} ${response.statusText})`
    )
  }

  return codexModelsResponseSchema
    .parse(await response.json())
    .models.filter(model => model.visibility === 'list')
    .filter(model => model.supported_in_api === true)
    .sort(
      (left, right) =>
        (left.priority ?? Number.MAX_SAFE_INTEGER) -
        (right.priority ?? Number.MAX_SAFE_INTEGER)
    )
    .map(model => ({
      id: model.slug,
      name: model.display_name,
      ...(model.description ? { description: model.description } : {}),
      priority: model.priority,
    }))
}

export function createOpenaiOptions(
  isCodex: boolean,
  opts: OpenAIResponsesProviderOptions = {}
): OpenAIResponsesProviderOptions {
  // ChatGPT's Codex endpoint only accepts ephemeral Responses API calls.
  // The normal OpenAI endpoint permits this field to be omitted, but Codex
  // requires it explicitly even on streaming requests.
  return isCodex ? { ...opts, store: false } : { ...opts }
}

export type OpenaiCreateOptions = {
  apiKey?: string
  accountId?: string
}

export const codex = (config?: OpenaiCreateOptions) =>
  createOpenAI({
    name: 'codex',
    apiKey: config?.apiKey ?? '',
    baseURL: 'https://chatgpt.com/backend-api/codex',
    headers: {
      ...(config?.accountId
        ? { 'chatgpt-account-id': config.accountId }
        : {}),
      originator: 'sensos',
      'OpenAI-Beta': 'responses=experimental',
    },
  })

export function createCodexHarnessProvider(
  credential?: CodexCredential,
  dependencies: {
    fetch?: ModelCatalogFetch
    config?: OpenaiCreateOptions
  } = {}
) {
  const provider = codex({
    ...dependencies.config,
    apiKey: credential?.accessToken ?? dependencies.config?.apiKey,
    accountId: credential?.accountId ?? dependencies.config?.accountId,
  })
  return new SensosHarnessProvider({
    sensosId: 'codex',
    provider,
    defaultModelId: CODEX_DEFAULT_MODEL,
    async listModels() {
      if (!credential) {
        throw new Error(
          'Codex is not connected. Run `sensos login codex` first.'
        )
      }
      return getCodexModels(credential, dependencies.fetch)
    },
    auth: {
      login: (options: CodexLoginOptions) =>
        loginWithCodex(options.openUrl, options.signal),
      token: value => Promise.resolve(value.accessToken),
      user: value => Promise.resolve({ accountId: value.accountId }),
    },
  })
}

export const openai = (config?: OpenaiCreateOptions) =>
  createOpenAI({
    name: 'openai',
    apiKey: config?.apiKey ?? '',
  })
