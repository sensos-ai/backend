import { expect, test } from 'bun:test'
import type { UIMessage } from 'ai'
import { queryTestActor } from '../../../../fixtures/rivet/query-test-actor'
import {
  createRivetTest,
  createTestRegistry,
} from '../../../../helpers/rivet-test'

test('persists run state, frames, cancellation, title, and deletion', async () => {
  const { client, trackedActorKey } = await createRivetTest(
    { name: 'durable query behavior' },
    () => createTestRegistry({ queryTestActor })
  )
  const handle = client.queryTestActor.getOrCreate([
    trackedActorKey('queryTestActor', 'durability'),
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
  const busy = await handle.submit({
    ...input,
    runId: 'run_2',
    idempotencyId: 'request_2',
    message: { ...userMessage, id: 'msg_user_2' },
  })

  expect(first).toMatchObject({ accepted: true, created: true })
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
