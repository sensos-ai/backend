import {
  createOpenAI,
  type OpenAIResponsesProviderOptions,
} from '@ai-sdk/openai'

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
