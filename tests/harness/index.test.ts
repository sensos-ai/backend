import { describe, expect, test } from 'bun:test'
import type { UIMessage } from 'ai'
import { createHarness } from '@/chat/harness'

describe('createHarness', () => {
  test('accepts and exposes initial messages', () => {
    const initialMessages: UIMessage[] = [
      {
        id: 'msg_initial',
        role: 'user',
        parts: [{ type: 'text', text: 'hello' }],
      },
    ]

    const harness = createHarness({
      sandbox: {
        id: 'sandbox_test',
        cwd: '/workspace',
      } as never,
      signal: new AbortController().signal,
      model: 'openai/gpt-5.6-sol',
      initialMessages,
    })

    expect(harness.initialMessages).toEqual(initialMessages)
  })

  test('defaults initial messages to an empty transcript', () => {
    const harness = createHarness({
      sandbox: {
        id: 'sandbox_test',
        cwd: '/workspace',
      } as never,
      signal: new AbortController().signal,
      model: 'openai/gpt-5.6-sol',
    })

    expect(harness.initialMessages).toEqual([])
  })

  test('exposes resolved feature flags to harness consumers', () => {
    const harness = createHarness({
      sandbox: {
        id: 'sandbox_test',
        cwd: '/workspace',
      } as never,
      signal: new AbortController().signal,
      model: 'openai/gpt-5.6-sol',
      features: { useMockModel: false },
    })

    expect(harness.features).toEqual({ useMockModel: false })
  })
})
