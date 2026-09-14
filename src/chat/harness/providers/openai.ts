import {
  createOpenAI,
  type OpenAIResponsesProviderOptions,
} from '@ai-sdk/openai'
import { z } from 'zod'
import type { CodexCredential } from '@/auth/profile'
import type { AvailableModel } from './model-catalog'

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
    })
  ),
})

export async function getCodexModels(
  credential: CodexCredential,
  fetchImpl: ModelCatalogFetch = fetch
): Promise<AvailableModel[]> {
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
    .models.filter(model => model.visibility !== 'hide')
    .filter(model => model.supported_in_api !== false)
    .map(model => ({
      id: model.slug,
      name: model.display_name,
      ...(model.description ? { description: model.description } : {}),
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

export const openai = (config?: OpenaiCreateOptions) =>
  createOpenAI({
    name: 'openai',
    apiKey: config?.apiKey ?? '',
  })
