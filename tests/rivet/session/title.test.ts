import { describe, expect, test } from 'bun:test'
import { MockLanguageModelV3 } from 'ai/test'
import {
  generateSessionTitle,
  normalizeSessionTitle,
  shouldGenerateSessionTitle,
  TITLE_MODEL,
  userMessageText,
} from '@/runtime/actors/session/title'

const usage = {
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
}

describe('session titles', () => {
  test('uses the verified gateway nano model id', () => {
    expect(TITLE_MODEL).toBe('openai/gpt-5-nano')
  })

  test('extracts only user text and normalizes the generated title', () => {
    expect(
      userMessageText({
        id: 'msg_1',
        role: 'user',
        parts: [
          { type: 'text', text: 'Fix the' },
          { type: 'text', text: ' session actor' },
        ],
      })
    ).toBe('Fix the session actor')
    expect(normalizeSessionTitle('  "Fix   session actor"  ')).toBe(
      'Fix session actor'
    )
  })

  test('uses the deterministic title model when requested by a run', async () => {
    expect(
      await generateSessionTitle('Explain why actor titles stay pending', {
        features: { useMockModel: true },
      })
    ).toBe('Explain why actor titles stay pending')
  })

  test('generates through AI SDK and retries on later created runs without a title', async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ type: 'text', text: '  Session actor lifecycle  ' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage,
        warnings: [],
      }),
    })
    expect(
      await generateSessionTitle('Please fix the session actor', { model })
    ).toBe('Session actor lifecycle')
    expect(
      shouldGenerateSessionTitle({ created: true, revision: 1 })
    ).toBe(true)
    expect(
      shouldGenerateSessionTitle({ created: false, revision: 1 })
    ).toBe(false)
    expect(
      shouldGenerateSessionTitle({ created: true, revision: 2 })
    ).toBe(true)
    expect(
      shouldGenerateSessionTitle({
        created: true,
        revision: 1,
        title: 'Existing',
      })
    ).toBe(false)
  })
})
