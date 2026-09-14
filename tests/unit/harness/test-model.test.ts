import { describe, expect, test } from 'bun:test'
import {
  createTestLanguageModel,
  testModelEnabled,
} from '@/chat/harness/providers/test-model'

describe('test model', () => {
  test('enables only for the exact value 1', () => {
    expect(testModelEnabled({ SENSOS_USE_TEST_MODEL: '1' })).toBe(true)
    expect(testModelEnabled({ SENSOS_USE_TEST_MODEL: '0' })).toBe(false)
    expect(testModelEnabled({ SENSOS_USE_TEST_MODEL: 'true' })).toBe(false)
    expect(testModelEnabled({})).toBe(false)
  })

  test('streams reasoning, text, and a tool call without echoing input', async () => {
    const model = createTestLanguageModel({ chunkDelayInMs: 0 })
    const result = await model.doStream({
      prompt: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'hello test model' }],
        },
      ],
    } as Parameters<typeof model.doStream>[0])
    const chunks = []
    for await (const chunk of result.stream) chunks.push(chunk)

    expect(chunks.some(chunk => chunk.type === 'reasoning-start')).toBe(
      true
    )
    expect(chunks.some(chunk => chunk.type === 'tool-input-start')).toBe(
      true
    )
    expect(chunks.some(chunk => chunk.type === 'tool-input-delta')).toBe(
      true
    )
    expect(chunks.some(chunk => chunk.type === 'tool-call')).toBe(true)
    expect(JSON.stringify(chunks)).not.toContain('hello test model')
  })

  test('streams a final response after the tool result', async () => {
    const model = createTestLanguageModel({ chunkDelayInMs: 0 })
    const result = await model.doStream({
      prompt: [
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'test-tool-call-1',
              toolName: 'bash',
              output: { type: 'json', value: { stdout: '/workspace' } },
            },
          ],
        },
      ],
    } as Parameters<typeof model.doStream>[0])
    const chunks = []
    for await (const chunk of result.stream) chunks.push(chunk)

    expect(chunks.some(chunk => chunk.type === 'tool-call')).toBe(false)
    expect(
      chunks
        .filter(chunk => chunk.type === 'text-delta')
        .map(chunk => chunk.delta)
        .join('')
    ).toBe(
      'The test model completed a streamed reasoning, text, and tool-call sequence.'
    )
  })

  test('always observes cancellation without an environment flag', async () => {
    const model = createTestLanguageModel({ chunkDelayInMs: 100 })
    const abort = new AbortController()
    const result = await model.doStream({
      prompt: [],
      abortSignal: abort.signal,
    } as Parameters<typeof model.doStream>[0])
    abort.abort()
    await expect(Array.fromAsync(result.stream)).rejects.toThrow(
      'Test model provider aborted'
    )
  })

  test('observes cancellation before the stream controller is attached', async () => {
    const model = createTestLanguageModel({ chunkDelayInMs: 0 })
    const abort = new AbortController()
    abort.abort()
    const result = await model.doStream({
      prompt: [],
      abortSignal: abort.signal,
    } as Parameters<typeof model.doStream>[0])
    await expect(Array.fromAsync(result.stream)).rejects.toThrow(
      'Test model provider aborted'
    )
  })
})
