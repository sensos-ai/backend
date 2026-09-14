import { expect, onTestFinished, test } from 'bun:test'
import type { UIMessage } from 'ai'
import { createIdGeneratorWithPrefix } from '@/shared/utils'
import { createRivetTestClient } from '../../fixtures/rivet/client'
import type {
  DeliveryRoutedEvent,
  FrameEvent,
  InboxMessage,
  StatusChangedEvent,
} from '@/runtime/actors/session/config'

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

function waitForEvent<T>(
  subscribe: (listener: (event: T) => void) => () => void,
  predicate: (event: T) => boolean
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe()
      reject(new Error('Timed out waiting for actor event'))
    }, 10_000)
    const unsubscribe = subscribe(event => {
      if (!predicate(event)) return
      clearTimeout(timer)
      unsubscribe()
      resolve(event)
    })
  })
}

async function waitForCompletedRun(
  getRun: (runId: string) => Promise<{ status: string } | undefined>,
  runId: string
): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if ((await getRun(runId))?.status === 'completed') return
    await Bun.sleep(25)
  }
  throw new Error(`Timed out waiting for run ${runId} to complete`)
}

test('completable run queue durably creates and deduplicates a run', async () => {
  const client = createRivetTestClient()
  onTestFinished(() => client.dispose())
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
  const connection = client.session
    .getOrCreate([createTestId()], {
      createWithInput: { cwd: process.cwd() },
    })
    .connect({ clientId: createTestId() })

  const initialDelivery = inbox('adaptive', 'start the first turn')
  const firstStarted = waitForEvent<DeliveryRoutedEvent>(
    listener => connection.on('deliveryRouted', listener),
    event => event.id === initialDelivery.id && event.status === 'started'
  )
  const firstRunning = waitForEvent<StatusChangedEvent>(
    listener => connection.on('statusChanged', listener),
    event => event.runStatus === 'running'
  )
  await connection.deliver(initialDelivery)
  const started = await firstStarted
  await firstRunning
  expect(started.runId).toMatch(/^run_/)

  const partialAssistantOutput = waitForEvent<FrameEvent>(
    listener => connection.on('frame', listener),
    event =>
      event.runId === started.runId && event.chunk.type === 'text-delta'
  )
  await partialAssistantOutput

  const steering = inbox('now', 'interrupt into a new turn')
  const steeredReceipt = waitForEvent<DeliveryRoutedEvent>(
    listener => connection.on('deliveryRouted', listener),
    event => event.id === steering.id && event.status === 'steered'
  )
  const interrupted = waitForEvent<StatusChangedEvent>(
    listener => connection.on('statusChanged', listener),
    event =>
      event.runId === started.runId && event.runStatus === 'interrupted'
  )
  const interruptStarted = waitForEvent<DeliveryRoutedEvent>(
    listener => connection.on('deliveryRouted', listener),
    event => event.id === steering.id && event.status === 'started'
  )
  const successorRunning = waitForEvent<StatusChangedEvent>(
    listener => connection.on('statusChanged', listener),
    event => event.runId !== started.runId && event.runStatus === 'running'
  )
  await connection.deliver(steering)
  expect((await steeredReceipt).runId).toBe(started.runId)
  await interrupted
  const successor = await interruptStarted
  expect(successor.runId).not.toBe(started.runId)

  if (!successor.runId)
    throw new Error('Missing interrupt successor run id')
  expect((await successorRunning).runId).toBe(successor.runId)

  const adaptiveSteering = inbox('adaptive', 'adapt this same turn')
  const adaptiveReceipt = waitForEvent<DeliveryRoutedEvent>(
    listener => connection.on('deliveryRouted', listener),
    event => event.id === adaptiveSteering.id && event.status === 'steered'
  )
  await connection.deliver(adaptiveSteering)
  expect((await adaptiveReceipt).runId).toBe(successor.runId)

  const next = inbox('next', 'run only after the first turn')
  const queuedReceipt = waitForEvent<DeliveryRoutedEvent>(
    listener => connection.on('deliveryRouted', listener),
    event => event.id === next.id && event.status === 'queued'
  )
  const nextStarted = waitForEvent<DeliveryRoutedEvent>(
    listener => connection.on('deliveryRouted', listener),
    event => event.id === next.id && event.status === 'started'
  )
  await connection.deliver(next)
  await queuedReceipt
  expect(
    (await connection.getSession()).messages.some(
      (message: UIMessage) => message.id === next.id
    )
  ).toBe(false)

  await waitForCompletedRun(
    runId => connection.getRun(runId),
    successor.runId
  )
  const second = await nextStarted
  expect(second.runId).not.toBe(successor.runId)

  if (!second.runId) throw new Error('Missing second run id')
  await waitForCompletedRun(
    runId => connection.getRun(runId),
    second.runId
  )

  const messages = (await connection.getSession()).messages
  if (!started.runId) throw new Error('Missing first run id')
  const interruptedRun = await connection.getRun(started.runId)
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
  ).toBeGreaterThan(messageIds.indexOf(initialDelivery.id))
  expect(messageIds.indexOf(steering.id)).toBeGreaterThan(
    messageIds.indexOf(interruptedRun.assistantMessageId)
  )
  expect(
    messages.filter((message: UIMessage) => message.id === next.id)
  ).toHaveLength(1)
  expect(messageIds).toEqual(
    expect.arrayContaining([
      initialDelivery.id,
      steering.id,
      adaptiveSteering.id,
      next.id,
    ])
  )
}, 30_000)
