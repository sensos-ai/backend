import { describe, expect, test } from 'bun:test'
import type { UIMessage } from 'ai'
import {
  cutoffAssistantMessage,
  hasAssistantContent,
  isWaitingForHumanInput,
  messageWithOrigin,
} from '@/runtime/actors/session/utils/messages'

describe('session message decisions', () => {
  test('adds origin without mutating existing metadata', () => {
    const message: UIMessage = {
      id: 'm1',
      role: 'user',
      metadata: { existing: true },
      parts: [{ type: 'text', text: 'hello' }],
    }
    const routed = messageWithOrigin({
      id: 'delivery-1',
      message,
      priority: 'next',
      origin: { type: 'system' },
      createdAt: Date.now(),
    })
    expect(routed.metadata).toEqual({
      existing: true,
      sensosOrigin: { type: 'system' },
    })
    expect(message.metadata).toEqual({ existing: true })
  })

  test('detects only manual approval on the latest assistant message', () => {
    const manual = {
      id: 'a1',
      role: 'assistant',
      parts: [
        {
          type: 'dynamic-tool',
          toolName: 'ask',
          toolCallId: 't1',
          state: 'approval-requested',
          input: {},
          approval: { id: 'p1' },
        },
      ],
    } as UIMessage
    expect(isWaitingForHumanInput([manual])).toBe(true)
    expect(isWaitingForHumanInput([])).toBe(false)
    expect(
      isWaitingForHumanInput([{ id: 'u1', role: 'user', parts: [] }])
    ).toBe(false)
  })

  test('constructs a cutoff only when the stream has no content', () => {
    const empty: UIMessage = {
      id: 'a1',
      role: 'assistant',
      parts: [{ type: 'step-start' }],
    }
    expect(hasAssistantContent(empty)).toBe(false)
    expect(cutoffAssistantMessage('a1', empty, '[Stopped]').parts).toEqual(
      [{ type: 'text', text: '[Stopped]', state: 'done' }]
    )
  })
})
