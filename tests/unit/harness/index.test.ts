import { describe, expect, test } from 'bun:test'
import { createAgentUIStream, type UIMessage } from 'ai'
import {
  appendSteeringMessages,
  createHarness,
  type SteeringMessage,
} from '@/chat/harness'
import { createTestLanguageModel } from '@/chat/harness/providers/test-model'

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

  test('drains active-run steering at the next test-model prepareStep boundary', async () => {
    let prepareSteps = 0
    const steeringMessage: SteeringMessage = {
      message: {
        id: 'msg_steer',
        role: 'user',
        parts: [{ type: 'text', text: 'change course now' }],
      },
      origin: { type: 'session', sessionId: 'session_peer' },
    }
    const harness = createHarness({
      sandbox: {
        id: 'sandbox_test',
        provider: 'agentos',
        cwd: '/workspace',
        run: async () => ({
          exitCode: 0,
          stdout: '/workspace',
          stderr: '',
        }),
        files: {},
      } as never,
      signal: new AbortController().signal,
      languageModel: createTestLanguageModel({ chunkDelayInMs: 0 }),
      initialMessages: [
        {
          id: 'msg_initial',
          role: 'user',
          parts: [{ type: 'text', text: 'start a tool loop' }],
        },
      ],
      steeringInput: {
        drain() {
          prepareSteps += 1
          return prepareSteps === 2 ? [steeringMessage] : []
        },
      },
    })

    const stream = await createAgentUIStream({
      agent: harness.agent,
      uiMessages: harness.initialMessages,
    })
    for await (const _chunk of stream) {
      // Consume the deterministic two-step test-model run.
    }

    expect(prepareSteps).toBe(2)
  })

  test('adds origin attribution only to drained steering model input', async () => {
    const appended = await appendSteeringMessages(
      [{ role: 'user', content: 'original' }],
      {
        drain: () => [
          {
            message: {
              id: 'msg_peer',
              role: 'user',
              parts: [{ type: 'text', text: 'peer update' }],
            },
            origin: { type: 'session', sessionId: 'session_peer' },
          },
        ],
      }
    )

    expect(appended).toEqual([
      { role: 'user', content: 'original' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '[Session session_peer]\npeer update' },
        ],
      },
    ])
  })
})
