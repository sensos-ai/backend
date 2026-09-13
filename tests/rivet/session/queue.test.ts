import { expect, onTestFinished, test } from 'bun:test'
import type { UIMessage } from 'ai'
import { setup } from 'rivetkit'
import { setupTest } from 'rivetkit/test'
import { createIdGeneratorWithPrefix } from '@/lib/utils'
import { sessionAgent } from '@/registry/actors/session'

const createTestId = createIdGeneratorWithPrefix('queue_test')

test('completable run queue durably creates and deduplicates a run', async () => {
  const previousTestModel = process.env.SENSOS_USE_TEST_MODEL
  process.env.SENSOS_USE_TEST_MODEL = '1'
  onTestFinished(() => {
    if (previousTestModel === undefined) {
      delete process.env.SENSOS_USE_TEST_MODEL
    } else {
      process.env.SENSOS_USE_TEST_MODEL = previousTestModel
    }
  })

  const registry = setup({ use: { session: sessionAgent } })
  const { client } = await setupTest({ onTestFinished } as never, registry)
  onTestFinished(() => registry.shutdown())
  const handle = client.session.getOrCreate([createTestId()], {
    createWithInput: { cwd: process.cwd() },
    params: { clientId: createTestId() },
  })
  const message: UIMessage = {
    id: createTestId(),
    role: 'user',
    parts: [{ type: 'text', text: 'verify durable queue submission' }],
  }
  const command = {
    idempotencyId: createTestId(),
    model: 'openai/gpt-5.6-sol' as const,
    message,
  }

  const first = await handle.send('runs', command, {
    wait: true,
    timeout: 10_000,
  })
  expect(first).toMatchObject({
    status: 'completed',
    response: { accepted: true, deduplicated: false },
  })
  if (!first.response) throw new Error('Missing first queue completion')

  const persisted = await handle.getRun(first.response.runId)
  expect(persisted).toMatchObject({
    id: first.response.runId,
    idempotencyId: command.idempotencyId,
    model: command.model,
  })
  expect((await handle.getSession()).messages).toContainEqual(message)

  const duplicate = await handle.send('runs', command, {
    wait: true,
    timeout: 10_000,
  })
  expect(duplicate).toMatchObject({
    status: 'completed',
    response: {
      accepted: true,
      deduplicated: true,
      runId: first.response.runId,
    },
  })
  expect((await handle.getSession()).messages).toEqual(
    expect.arrayContaining([message])
  )
  expect(
    (await handle.getSession()).messages.filter(
      (value: UIMessage) => value.id === message.id
    )
  ).toHaveLength(1)
}, 20_000)
