import {
  createOpenAI,
  type OpenAIResponsesProviderOptions,
} from '@ai-sdk/openai'

export type CodexModelId = `gpt-${string}` | (string & {})
export const CODEX_DEFAULT_MODEL: CodexModelId = 'gpt-5.6-sol'

export function createOpenaiOptions(
  isCodex: boolean,
  opts: OpenAIResponsesProviderOptions = {}
): OpenAIResponsesProviderOptions {
  return isCodex ? { ...opts, store: false } : { ...opts }
}

export const codex = () =>
  createOpenAI({
    name: 'codex',
    apiKey: process.env.CODEX_ACCESS_TOKEN,
    baseURL: 'https://chatgpt.com/backend-api/codex',
    headers: {
      ...(process.env.CODEX_ACCOUNT_ID
        ? { 'chatgpt-account-id': process.env.CODEX_ACCOUNT_ID }
        : {}),
      originator: 'sensos',
      'OpenAI-Beta': 'responses=experimental',
    },
  })
