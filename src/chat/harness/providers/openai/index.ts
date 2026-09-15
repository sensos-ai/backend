import {
  createOpenAI,
  type OpenAIResponsesProviderOptions,
} from '@ai-sdk/openai'
import { z } from 'zod'
import {
  getCodexUser,
  loginWithCodexDevice,
  loginWithCodex,
  refreshCodexCredential,
} from '@/auth/oauth/codex'
import {
  SensosHarnessProvider,
  type HarnessLoginOptions,
  type HarnessModel,
} from '../harness-provider'
import {
  openBrowser,
  type HarnessAuthInteraction,
} from '../auth-interaction'

export type CodexModelId = `gpt-${string}` | (string & {})

export type CodexCredential = {
  kind: 'oauth'
  accessToken: string
  refreshToken: string
  expiresAt: number
  accountId: string
}

export interface CodexCatalogModel extends HarnessModel<CodexModelId> {
  priority: number
}

export const CODEX_AUTH_STRATEGIES = [
  'oauth-pkce',
  'oauth-device',
] as const
export type CodexLoginOptions = HarnessLoginOptions<
  { type: 'oauth-pkce' } | { type: 'oauth-device' }
>

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
    apiKey: config?.apiKey,
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
    openUrl?: (url: string) => Promise<void>
    log?: (message: string) => void
    error?: (message: string) => void
    interaction?: Pick<HarnessAuthInteraction, 'openUrl' | 'log' | 'error'>
    loginWithPkce?: typeof loginWithCodex
    loginWithDevice?: typeof loginWithCodexDevice
  } = {}
) {
  const provider = codex({
    ...dependencies.config,
    apiKey: credential?.accessToken ?? dependencies.config?.apiKey,
    accountId: credential?.accountId ?? dependencies.config?.accountId,
  })
  return new SensosHarnessProvider({
    sensosId: 'codex',
    authKey: 'codex',
    displayName: 'OpenAI Codex',
    supportedAuthStrategies: CODEX_AUTH_STRATEGIES,
    defaultAuthStrategy: 'oauth-pkce',
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
      isCredential: (value): value is CodexCredential => {
        if (!value || typeof value !== 'object') return false
        const candidate = value as Record<string, unknown>
        return (
          candidate.kind === 'oauth' &&
          typeof candidate.accessToken === 'string' &&
          typeof candidate.refreshToken === 'string' &&
          typeof candidate.expiresAt === 'number' &&
          typeof candidate.accountId === 'string'
        )
      },
      async login(options: CodexLoginOptions) {
        const log =
          dependencies.interaction?.log ?? dependencies.log ?? console.log
        const error =
          dependencies.interaction?.error ??
          dependencies.error ??
          console.error
        const openUrl =
          dependencies.interaction?.openUrl ??
          dependencies.openUrl ??
          openBrowser
        log(
          options.strategy.type === 'oauth-device'
            ? 'Starting OpenAI Codex device sign-in.'
            : 'Opening OpenAI Codex sign-in in your browser.'
        )
        const credential =
          options.strategy.type === 'oauth-device'
            ? await (dependencies.loginWithDevice ?? loginWithCodexDevice)(
                {
                  onDeviceCode: async (verificationUrl, userCode) => {
                    log(`Open this URL to sign in:\n${verificationUrl}`)
                    log(`Enter this one-time code:\n${userCode}`)
                    log('Never share this one-time code with anyone.')
                    try {
                      await openUrl(verificationUrl)
                    } catch {
                      error('Could not open a browser. Use the URL above.')
                    }
                    log('Waiting for sign-in...')
                  },
                  signal: options.signal,
                }
              )
            : await (dependencies.loginWithPkce ?? loginWithCodex)(
                async url => {
                  try {
                    await openUrl(url)
                  } catch {
                    error('Could not open a browser. Use this URL:')
                    log(url)
                  }
                },
                options.signal
              )
        log('Connected to OpenAI Codex.')
        return { ...credential, kind: 'oauth' as const }
      },
      needsRefresh: (value): value is CodexCredential =>
        value.expiresAt <= Date.now() + 60_000,
      token: value => Promise.resolve(value.accessToken),
      logout: () => Promise.resolve(),
      refresh: async value => ({
        ...(await refreshCodexCredential(value, dependencies.fetch)),
        kind: 'oauth',
      }),
      user: value => getCodexUser(value, dependencies.fetch),
    },
  })
}

export const openai = (config?: OpenaiCreateOptions) =>
  createOpenAI({
    name: 'openai',
    apiKey: config?.apiKey,
  })
