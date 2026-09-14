import { expect, test } from 'bun:test'
import type { UIMessage } from 'ai'
import { sessionAgent } from '@/runtime/actors/session'
import type {
  DeliveryRoutedEvent,
  FrameEvent,
  InboxMessage,
  StatusChangedEvent,
} from '@/runtime/actors/session/config'
import { createIdGeneratorWithPrefix } from '@/shared/utils'
import {
  createRivetTest,
  createTestRegistry,
} from '../../../helpers/rivet-test'
import { waitForEvent, waitForValue } from '../../../helpers/wait'

const createTestId = createIdGeneratorWithPrefix('queue_test')

function inbox(
  priority: InboxMessage['priority'],
  text: string,
  id = createTestId()
): InboxMessage {
  return {
    id,
    priority,
    createdAt: Date.now(),
    origin: { type: 'client', clientId: 'test-client' },
    message: {
      id,
      role: 'user',
      parts: [{ type: 'text', text }],
    },
  }
}

async function createSessionTest(name: string) {
  return createRivetTest({ name }, () =>
    createTestRegistry({ session: sessionAgent })
  )
}

async function waitForCompletedRun(
  getRun: (runId: string) => Promise<{ status: string } | undefined>,
  runId: string
): Promise<void> {
  await waitForValue(
    () => getRun(runId),
    run => run?.status === 'completed',
    { description: `run ${runId} to complete` }
  )
}

test('run submission persists once and deduplicates retries', async () => {
  const { client, actorKey, trackedActorKey } = await createSessionTest(
    'run submission deduplication'
  )
  const handle = client.session.getOrCreate([trackedActorKey('session')], {
    createWithInput: { cwd: process.cwd() },
    params: { clientId: actorKey('client') },
  })
  const message: UIMessage = {
    id: createTestId(),
    role: 'user',
    parts: [{ type: 'text', text: 'verify durable queue submission' }],
  }
  const command = {
    idempotencyId: createTestId(),
    model: {
      provider: 'gateway' as const,
      modelId: 'openai/gpt-5.6-sol' as const,
    },
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

  expect(await handle.getRun(first.response.runId)).toMatchObject({
    id: first.response.runId,
    idempotencyId: command.idempotencyId,
    modelProvider: command.model.provider,
    modelId: command.model.modelId,
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
  expect(
    (await handle.getSession()).messages.filter(
      (value: UIMessage) => value.id === message.id
    )
  ).toHaveLength(1)
}, 20_000)

test('now delivery interrupts the active run and starts a successor', async () => {
  const { client, actorKey, trackedActorKey, cleanup } =
    await createSessionTest('now actor delivery')
  const connection = client.session
    .getOrCreate([trackedActorKey('session')], {
      createWithInput: { cwd: process.cwd() },
    })
    .connect({ clientId: actorKey('client') })
  cleanup(() => connection.dispose())

  const initial = inbox('adaptive', 'start the first turn')
  const firstStarted = waitForEvent<DeliveryRoutedEvent>(
    listener => connection.on('deliveryRouted', listener),
    event => event.id === initial.id && event.status === 'started',
    { description: 'initial delivery to start' }
  )
  const firstFrame = waitForEvent<FrameEvent>(
    listener => connection.on('frame', listener),
    event => event.chunk.type === 'text-delta',
    { description: 'initial run output' }
  )
  await connection.deliver(initial)
  const interruptedRunId = (await firstStarted).runId
  if (!interruptedRunId) throw new Error('Missing initial run id')
  await firstFrame

  const steering = inbox('now', 'interrupt into a new turn')
  const steered = waitForEvent<DeliveryRoutedEvent>(
    listener => connection.on('deliveryRouted', listener),
    event => event.id === steering.id && event.status === 'steered',
    { description: 'now delivery to steer the active run' }
  )
  const interrupted = waitForEvent<StatusChangedEvent>(
    listener => connection.on('statusChanged', listener),
    event =>
      event.runId === interruptedRunId &&
      event.runStatus === 'interrupted',
    { description: 'active run to become interrupted' }
  )
  const successorStarted = waitForEvent<DeliveryRoutedEvent>(
    listener => connection.on('deliveryRouted', listener),
    event => event.id === steering.id && event.status === 'started',
    { description: 'steering delivery to start its successor' }
  )
  await connection.deliver(steering)

  expect((await steered).runId).toBe(interruptedRunId)
  await interrupted
  const successorRunId = (await successorStarted).runId
  expect(successorRunId).not.toBe(interruptedRunId)
  if (!successorRunId) throw new Error('Missing successor run id')
  await waitForCompletedRun(
    runId => connection.getRun(runId),
    successorRunId
  )

  const messages = (await connection.getSession()).messages
  const interruptedRun = await connection.getRun(interruptedRunId)
  if (!interruptedRun) throw new Error('Missing interrupted run')
  const messageIds = messages.map((message: UIMessage) => message.id)
  const cutoff = messages.find(
    (message: UIMessage) =>
      message.id === interruptedRun.assistantMessageId
  )
  expect(
    cutoff?.parts.some(
      (part: UIMessage['parts'][number]) =>
        (part.type === 'text' || part.type === 'reasoning') &&
        part.text.length > 0
    )
  ).toBe(true)
  expect(
    messageIds.indexOf(interruptedRun.assistantMessageId)
  ).toBeGreaterThan(messageIds.indexOf(initial.id))
  expect(messageIds.indexOf(steering.id)).toBeGreaterThan(
    messageIds.indexOf(interruptedRun.assistantMessageId)
  )
}, 20_000)

test('adaptive delivery steers the active run without replacing it', async () => {
  const { client, actorKey, trackedActorKey, cleanup } =
    await createSessionTest('adaptive actor delivery')
  const connection = client.session
    .getOrCreate([trackedActorKey('session')], {
      createWithInput: { cwd: process.cwd() },
    })
    .connect({ clientId: actorKey('client') })
  cleanup(() => connection.dispose())

  const initial = inbox('adaptive', 'start the first turn')
  const started = waitForEvent<DeliveryRoutedEvent>(
    listener => connection.on('deliveryRouted', listener),
    event => event.id === initial.id && event.status === 'started',
    { description: 'initial delivery to start' }
  )
  const firstFrame = waitForEvent<FrameEvent>(
    listener => connection.on('frame', listener),
    event => event.chunk.type === 'text-delta',
    { description: 'active run output' }
  )
  await connection.deliver(initial)
  const runId = (await started).runId
  if (!runId) throw new Error('Missing active run id')
  await firstFrame

  const adaptive = inbox('adaptive', 'adapt this same turn')
  const receipt = waitForEvent<DeliveryRoutedEvent>(
    listener => connection.on('deliveryRouted', listener),
    event => event.id === adaptive.id && event.status === 'steered',
    { description: 'adaptive delivery to steer the active run' }
  )
  await connection.deliver(adaptive)
  expect((await receipt).runId).toBe(runId)
  await waitForCompletedRun(id => connection.getRun(id), runId)

  expect(
    (await connection.getSession()).messages.map(
      (message: UIMessage) => message.id
    )
  ).toEqual(expect.arrayContaining([initial.id, adaptive.id]))
}, 20_000)

test('next delivery waits for the active run before starting once', async () => {
  const { client, actorKey, trackedActorKey, cleanup } =
    await createSessionTest('next actor delivery')
  const connection = client.session
    .getOrCreate([trackedActorKey('session')], {
      createWithInput: { cwd: process.cwd() },
    })
    .connect({ clientId: actorKey('client') })
  cleanup(() => connection.dispose())

  const initial = inbox('adaptive', 'start the first turn')
  const started = waitForEvent<DeliveryRoutedEvent>(
    listener => connection.on('deliveryRouted', listener),
    event => event.id === initial.id && event.status === 'started',
    { description: 'initial delivery to start' }
  )
  const firstFrame = waitForEvent<FrameEvent>(
    listener => connection.on('frame', listener),
    event => event.chunk.type === 'text-delta',
    { description: 'active run output' }
  )
  await connection.deliver(initial)
  const firstRunId = (await started).runId
  if (!firstRunId) throw new Error('Missing first run id')
  await firstFrame

  const next = inbox('next', 'run only after the first turn')
  const queued = waitForEvent<DeliveryRoutedEvent>(
    listener => connection.on('deliveryRouted', listener),
    event => event.id === next.id && event.status === 'queued',
    { description: 'next delivery to queue' }
  )
  const nextStarted = waitForEvent<DeliveryRoutedEvent>(
    listener => connection.on('deliveryRouted', listener),
    event => event.id === next.id && event.status === 'started',
    { description: 'next delivery to start' }
  )
  await connection.deliver(next)
  await queued
  expect(
    (await connection.getSession()).messages.some(
      (message: UIMessage) => message.id === next.id
    )
  ).toBe(false)

  await waitForCompletedRun(id => connection.getRun(id), firstRunId)
  const nextRunId = (await nextStarted).runId
  expect(nextRunId).not.toBe(firstRunId)
  if (!nextRunId) throw new Error('Missing next run id')
  await waitForCompletedRun(id => connection.getRun(id), nextRunId)

  const messages = (await connection.getSession()).messages
  expect(
    messages.filter((message: UIMessage) => message.id === next.id)
  ).toHaveLength(1)
}, 20_000)
