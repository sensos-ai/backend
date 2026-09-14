import { expect, onTestFinished, test } from 'bun:test'
import type { UIMessage } from 'ai'
import { createRivetTestClient } from '../../../fixtures/rivet/client'

test('submit is idempotent and owns one durable active run', async () => {
  const client = createRivetTestClient()
  onTestFinished(() => client.dispose())
  const handle = client.queryTestActor.getOrCreate([
    `durability-${crypto.randomUUID()}`,
  ])
  const userMessage: UIMessage = {
    id: 'msg_user',
    role: 'user',
    parts: [{ type: 'text', text: 'hello' }],
  }
  const input = {
    runId: 'run_1',
    idempotencyId: 'request_1',
    model: 'openai/gpt-5.6-sol' as const,
    message: userMessage,
    assistantMessageId: 'msg_assistant',
  }

  const first = await handle.submit(input)
  const duplicate = await handle.submit({
    ...input,
    runId: 'run_duplicate',
  })
  const busy = await handle.submit({
    ...input,
    runId: 'run_2',
    idempotencyId: 'request_2',
    message: { ...userMessage, id: 'msg_user_2' },
  })

  expect(first).toMatchObject({ accepted: true, created: true })
  expect(duplicate).toMatchObject({
    accepted: true,
    created: false,
    run: { id: 'run_1' },
  })
  expect(busy).toMatchObject({
    accepted: false,
    created: false,
    run: { id: 'run_1' },
  })

  const assistantMessage: UIMessage = {
    id: 'msg_assistant',
    role: 'assistant',
    parts: [{ type: 'text', text: 'hi' }],
  }
  await handle.finish('run_1', assistantMessage)
  const snapshot = await handle.snapshot('run_1')

  expect(snapshot.meta).toMatchObject({ revision: 2, activeRunId: null })
  expect(snapshot.messages).toEqual([userMessage, assistantMessage])
  expect(snapshot.frames).toEqual([
    { seq: 0, chunk: { type: 'finish', finishReason: 'stop' } },
  ])

  const fallback = await handle.submit({
    ...input,
    runId: 'run_fallback',
    idempotencyId: userMessage.id,
    assistantMessageId: 'msg_fallback_assistant',
  })
  expect(fallback).toMatchObject({
    accepted: true,
    created: true,
    run: { id: 'run_fallback', userMessageId: userMessage.id },
  })
  expect((await handle.snapshot('run_fallback')).meta.revision).toBe(
    snapshot.meta.revision
  )
  expect(
    (await handle.snapshot('run_fallback')).messages.filter(
      message => message.id === userMessage.id
    )
  ).toHaveLength(1)
  await handle.finish('run_fallback', {
    id: 'msg_fallback_assistant',
    role: 'assistant',
    parts: [{ type: 'text', text: 'fallback response' }],
  })

  await handle.setTitle('Durable session title')
  expect((await handle.snapshot('run_1')).meta.title).toBe(
    'Durable session title'
  )

  const next = await handle.submit({
    ...input,
    runId: 'run_2',
    idempotencyId: 'request_2',
    message: { ...userMessage, id: 'msg_user_2' },
  })
  expect(next).toMatchObject({ accepted: true, created: true })
  expect(await handle.cancel('run_2')).toMatchObject({
    id: 'run_2',
    status: 'cancel_requested',
  })
  expect(await handle.cancel('run_1')).toBeUndefined()
  expect(await handle.getRun('run_1')).toMatchObject({
    status: 'completed',
    model: 'openai/gpt-5.6-sol',
    totalUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    responseMetadata: {
      id: 'response_1',
      modelId: 'gpt-5.6-sol-2026-09-01',
    },
  })

  await handle.deleteData()
  expect(await handle.snapshot('run_1')).toEqual({
    meta: {
      singletonId: 1,
      revision: 0,
      activeRunId: null,
      title: null,
    },
    messages: [],
    frames: [],
  })
}, 20_000)
