import { describe, expect, test } from 'bun:test'
import type { LanguageModelV4CallOptions } from '@ai-sdk/provider'
import { scriptedUsage, textTurn } from '../../fixtures/llm/scenario'
import { createScriptedLanguageModel } from '../../helpers/scripted-model'

function request(
  prompt: string,
  abortSignal?: AbortSignal
): LanguageModelV4CallOptions {
  return {
    prompt: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    abortSignal,
  }
}

async function chunks(
  model: ReturnType<typeof createScriptedLanguageModel>['model'],
  call: LanguageModelV4CallOptions
) {
  const result = await model.doStream(call)
  return Array.fromAsync(result.stream)
}

describe('scripted model', () => {
  test('keeps concurrent scenarios and gates isolated', async () => {
    const first = createScriptedLanguageModel({
      name: 'first',
      turns: [
        {
          expect: { promptContains: 'alpha' },
          chunks: [
            { type: 'text-start', id: 'a' },
            { type: 'text-delta', id: 'a', delta: 'alpha-' },
            { type: 'hold', gate: 'continue' },
            { type: 'text-delta', id: 'a', delta: 'done' },
            { type: 'text-end', id: 'a' },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: scriptedUsage,
            },
          ],
        },
      ],
    })
    const second = createScriptedLanguageModel({
      name: 'second',
      turns: [textTurn('bravo', { expect: { promptContains: 'beta' } })],
    })

    const firstChunks = chunks(first.model, request('alpha'))
    await first.controller.waitForRequest()
    const secondChunks = await chunks(second.model, request('beta'))
    expect(secondChunks).toContainEqual({
      type: 'text-delta',
      id: 'text-1',
      delta: 'bravo',
    })
    first.controller.release('continue')
    expect(await firstChunks).toContainEqual({
      type: 'text-delta',
      id: 'a',
      delta: 'done',
    })
    first.controller.assertConsumed()
    second.controller.assertConsumed()
  })

  test('observes an abort while held and emits nothing after the cutoff', async () => {
    const scripted = createScriptedLanguageModel({
      name: 'held cancellation',
      turns: [
        {
          chunks: [
            { type: 'text-start', id: 'answer' },
            { type: 'text-delta', id: 'answer', delta: 'partial' },
            { type: 'hold', gate: 'never' },
            { type: 'text-delta', id: 'answer', delta: 'forbidden' },
          ],
        },
      ],
    })
    const abort = new AbortController()
    const result = await scripted.model.doStream(
      request('cancel me', abort.signal)
    )
    const reader = result.stream.getReader()
    expect(await reader.read()).toEqual({
      done: false,
      value: { type: 'text-start', id: 'answer' },
    })
    expect((await reader.read()).value).toMatchObject({ delta: 'partial' })
    abort.abort()
    await scripted.controller.waitForAbort()
    await expect(reader.read()).rejects.toThrow()
    expect(scripted.controller.aborts).toHaveLength(1)
    scripted.controller.stop()
  })

  test('observes aborts that fire before stream attachment', async () => {
    const scripted = createScriptedLanguageModel({
      name: 'early cancellation',
      turns: [textTurn('not emitted')],
    })
    const abort = new AbortController()
    abort.abort()
    const result = await scripted.model.doStream(
      request('early', abort.signal)
    )
    await scripted.controller.waitForAbort()
    await expect(Array.fromAsync(result.stream)).rejects.toThrow()
  })

  test('reports turn and sanitized actual request on mismatch', async () => {
    const scripted = createScriptedLanguageModel({
      name: 'diagnostic',
      turns: [
        textTurn('unused', { expect: { promptContains: 'expected' } }),
      ],
    })
    await expect(
      scripted.model.doStream(request('actual prompt'))
    ).rejects.toThrow(
      'turn 0 expected prompt containing "expected"; actual'
    )
  })

  test('reports required turns left unconsumed', () => {
    const scripted = createScriptedLanguageModel({
      name: 'missing',
      turns: [textTurn('required')],
    })
    expect(() => scripted.controller.assertConsumed()).toThrow(
      'did not consume required turn 0'
    )
  })
})
