import '../../../setup'
import { expect, onTestFinished, test } from 'bun:test'
import type { UIMessage } from 'ai'
import { actor, setup } from 'rivetkit'
import { setupTest } from 'rivetkit/test'
import { sessionDatabase } from '@/runtime/actors/session/db/database'
import {
  deleteSessionData,
  finalizeRun,
  getRun,
  getSessionMeta,
  listMessages,
  listRunFrames,
  requestRunCancellation,
  setSessionTitle,
  submitRun,
} from '@/runtime/actors/session/db/queries'

const queryTestActor = actor({
  db: sessionDatabase,
  actions: {
    submit: (context, input: Parameters<typeof submitRun>[1]) =>
      submitRun(context.db, input),
    snapshot: async (context, runId: string) => ({
      meta: await getSessionMeta(context.db),
      messages: await listMessages(context.db),
      frames: await listRunFrames(context.db, runId),
    }),
    finish: (context, runId: string, assistantMessage: UIMessage) =>
      finalizeRun(context.db, runId, {
        status: 'completed',
        sequence: 0,
        chunk: { type: 'finish', finishReason: 'stop' },
        responseMessage: assistantMessage,
        finishReason: 'stop',
        steps: [
          {
            callId: 'call_1',
            stepNumber: 0,
            finishReason: 'stop',
            usage: {
              inputTokens: 10,
              inputTokenDetails: {
                noCacheTokens: 10,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
              },
              outputTokens: 5,
              outputTokenDetails: {
                textTokens: 5,
                reasoningTokens: 0,
              },
              totalTokens: 15,
            },
            response: {
              id: 'response_1',
              timestamp: '2026-09-12T00:00:00.000Z',
              modelId: 'gpt-5.6-sol-2026-09-01',
            },
          },
        ],
        totalUsage: {
          inputTokens: 10,
          inputTokenDetails: {
            noCacheTokens: 10,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
          outputTokens: 5,
          outputTokenDetails: {
            textTokens: 5,
            reasoningTokens: 0,
          },
          totalTokens: 15,
        },
        responseMetadata: {
          id: 'response_1',
          timestamp: '2026-09-12T00:00:00.000Z',
          modelId: 'gpt-5.6-sol-2026-09-01',
        },
      }),
    cancel: (context, runId: string) =>
      requestRunCancellation(context.db, runId),
    getRun: (context, runId: string) => getRun(context.db, runId),
    setTitle: (context, title: string) =>
      setSessionTitle(context.db, title),
    deleteData: context => deleteSessionData(context.db),
  },
})

const registry = setup({ use: { queryTestActor } })

test('submit is idempotent and owns one durable active run', async () => {
  const { client } = await setupTest({ onTestFinished } as never, registry)
  onTestFinished(() => registry.shutdown())
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
