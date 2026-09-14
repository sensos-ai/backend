import { afterEach, describe, expect, test } from 'bun:test'
import { createGateway } from '@ai-sdk/gateway'
import { scriptedUsage, textTurn } from '../../fixtures/llm/scenario'
import {
  startScriptedGateway,
  type ScriptedGateway,
} from '../../helpers/scripted-gateway'

const running: ScriptedGateway[] = []

afterEach(async () => {
  await Promise.all(running.splice(0).map(gateway => gateway.stop()))
})

describe('scripted gateway', () => {
  test('serves the native Gateway v4 stream on a dynamic loopback port', async () => {
    const gateway = startScriptedGateway({
      name: 'gateway text',
      turns: [
        textTurn('from gateway', {
          expect: {
            modelId: 'openai/test-model',
            promptContains: 'hello gateway',
          },
        }),
      ],
    })
    running.push(gateway)
    const provider = createGateway({
      baseURL: gateway.url,
      apiKey: 'test-key',
    })
    const result = await provider('openai/test-model').doStream({
      prompt: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'hello gateway' }],
        },
      ],
    })

    const chunks = await Array.fromAsync(result.stream)
    expect(chunks).toContainEqual({
      type: 'text-delta',
      id: 'text-1',
      delta: 'from gateway',
    })
    expect(gateway.requests).toHaveLength(1)
    gateway.assertConsumed()
  })

  test('observes HTTP cancellation once while a response is held', async () => {
    const gateway = startScriptedGateway({
      name: 'gateway abort',
      turns: [
        {
          chunks: [
            { type: 'text-start', id: 'held' },
            { type: 'text-delta', id: 'held', delta: 'partial' },
            { type: 'hold', gate: 'continue' },
            { type: 'text-end', id: 'held' },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: scriptedUsage,
            },
          ],
        },
      ],
    })
    running.push(gateway)
    const abort = new AbortController()
    const provider = createGateway({
      baseURL: gateway.url,
      apiKey: 'test-key',
    })
    const result = await provider('openai/test-model').doStream({
      prompt: [],
      abortSignal: abort.signal,
    })
    const reader = result.stream.getReader()
    expect((await reader.read()).value).toMatchObject({
      type: 'text-start',
    })
    expect((await reader.read()).value).toMatchObject({ delta: 'partial' })
    abort.abort()
    await gateway.waitForAbort()
    expect(gateway.aborts).toHaveLength(1)
  })

  test('returns request mismatch diagnostics across the HTTP boundary', async () => {
    const gateway = startScriptedGateway({
      name: 'gateway mismatch',
      turns: [
        textTurn('unused', { expect: { promptContains: 'wanted' } }),
      ],
    })
    running.push(gateway)
    const provider = createGateway({
      baseURL: gateway.url,
      apiKey: 'test-key',
    })
    await expect(
      provider('openai/test-model').doStream({
        prompt: [
          { role: 'user', content: [{ type: 'text', text: 'actual' }] },
        ],
      })
    ).rejects.toThrow('turn 0 expected prompt containing')
  })
})
