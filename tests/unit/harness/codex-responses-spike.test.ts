import { describe, expect, test } from 'bun:test'
import { createOpenAI } from '@ai-sdk/openai'
import { generateText } from 'ai'

describe('Codex Responses API compatibility spike', () => {
  test('the AI SDK Responses provider sends the Codex endpoint and required headers', async () => {
    let request: { url?: string; headers?: Headers; body?: unknown } = {}
    const codex = createOpenAI({
      name: 'codex',
      apiKey: 'oauth-access-token',
      baseURL: 'https://chatgpt.com/backend-api/codex',
      headers: {
        'chatgpt-account-id': 'account_test',
        originator: 'sensos',
        'OpenAI-Beta': 'responses=experimental',
      },
      fetch: (async (url, init) => {
        request = {
          url: String(url),
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body)),
        }
        return new Response(
          JSON.stringify({
            id: 'resp_test',
            created_at: 0,
            model: 'gpt-5.6-sol',
            output: [
              {
                type: 'message',
                id: 'msg_test',
                role: 'assistant',
                content: [
                  { type: 'output_text', text: 'hello', annotations: [] },
                ],
              },
            ],
          }),
          { headers: { 'content-type': 'application/json' } }
        )
      }) as typeof fetch,
    })

    const result = await generateText({
      model: codex.responses('gpt-5.6-sol'),
      prompt: 'Say hello.',
      providerOptions: { openai: { store: false } },
    })

    expect(result.text).toBe('hello')
    expect(request.url).toBe(
      'https://chatgpt.com/backend-api/codex/responses'
    )
    expect(request.headers?.get('authorization')).toBe(
      'Bearer oauth-access-token'
    )
    expect(request.headers?.get('chatgpt-account-id')).toBe('account_test')
    expect(request.headers?.get('originator')).toBe('sensos')
    expect(request.body).toMatchObject({
      model: 'gpt-5.6-sol',
      store: false,
      input: [{ role: 'user' }],
    })
  })
})
