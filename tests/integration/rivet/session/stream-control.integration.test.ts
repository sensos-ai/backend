import { expect, test } from 'bun:test'
import type { UIMessage, UIMessageChunk } from 'ai'
import { SessionChatTransport } from '@/chat/transport'
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

const createTestId = createIdGeneratorWithPrefix('stream_control')

function inbox(
  text: string,
  priority: InboxMessage['priority'] = 'adaptive'
): InboxMessage {
  const id = createTestId()
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

async function collect(stream: ReadableStream<UIMessageChunk>) {
  const chunks: UIMessageChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

async function createSessionTest(name: string) {
  return createRivetTest({ name }, () =>
    createTestRegistry({ session: sessionAgent })
  )
}

test('actor stream advances while disconnected and replays on reconnect', async () => {
  const { client, actorKey, trackedActorKey, cleanup } =
    await createSessionTest('stream disconnect recovery')
  const handle = client.session.getOrCreate([trackedActorKey('session')], {
    createWithInput: { cwd: process.cwd() },
  })
  const firstConnection = handle.connect({ clientId: actorKey('client') })
  cleanup(() => firstConnection.dispose())

  const delivery = inbox('keep generating after the client disconnects')
  const started = waitForEvent<DeliveryRoutedEvent>(
    listener => firstConnection.on('deliveryRouted', listener),
    event => event.id === delivery.id && event.status === 'started',
    { description: 'disconnect test run to start' }
  )
  const firstFrame = waitForEvent<FrameEvent>(
    listener => firstConnection.on('frame', listener),
    event => event.chunk.type === 'text-delta',
    { description: 'disconnect test output' }
  )
  await firstConnection.deliver(delivery)
  const runId = (await started).runId
  if (!runId) throw new Error('Missing active run id')
  const frameBeforeDisconnect = await firstFrame

  const queuedDelivery = inbox(
    'run this after the disconnected turn',
    'next'
  )
  expect(await firstConnection.deliver(queuedDelivery)).toMatchObject({
    id: queuedDelivery.id,
    status: 'queued',
  })
  await firstConnection.dispose()

  const resumedConnection = handle.connect({
    clientId: actorKey('client'),
  })
  cleanup(() => resumedConnection.dispose())
  const advancedAfterDisconnect = waitForEvent<FrameEvent>(
    listener => resumedConnection.on('frame', listener),
    event =>
      event.runId === runId && event.seq > frameBeforeDisconnect.seq,
    { description: 'stream frames to advance after disconnect' }
  )
  await advancedAfterDisconnect
  const queuedStarted = waitForEvent<DeliveryRoutedEvent>(
    listener => resumedConnection.on('deliveryRouted', listener),
    event => event.id === queuedDelivery.id && event.status === 'started',
    { description: 'queued delivery to start after reconnect' }
  )
  const resumed = await new SessionChatTransport(
    resumedConnection
  ).reconnectToStream({ chatId: 'resumed-chat' })
  expect(resumed).not.toBeNull()
  if (!resumed) throw new Error('Expected a resumable stream')

  const replayed = await collect(resumed)
  expect(replayed.length).toBeGreaterThan(frameBeforeDisconnect.seq)
  expect(replayed.at(-1)?.type).toBe('finish')
  expect(await resumedConnection.getRun(runId)).toMatchObject({
    id: runId,
    status: 'completed',
  })

  const queuedRunId = (await queuedStarted).runId
  if (!queuedRunId) throw new Error('Missing queued run id')
  await waitForValue(
    () => resumedConnection.getRun(queuedRunId),
    run => run?.status === 'completed',
    { description: 'queued run after reconnect to complete' }
  )

  const messages = (await resumedConnection.getSession()).messages
  expect(messages.map((message: UIMessage) => message.id)).toEqual([
    delivery.message.id,
    (await resumedConnection.getRun(runId))?.assistantMessageId,
    queuedDelivery.message.id,
    (await resumedConnection.getRun(queuedRunId))?.assistantMessageId,
  ])
}, 20_000)

test('transport stop cancels the active actor run and persists its cutoff', async () => {
  const { client, actorKey, trackedActorKey, cleanup } =
    await createSessionTest('transport stop behavior')
  const connection = client.session
    .getOrCreate([trackedActorKey('session')], {
      createWithInput: { cwd: process.cwd() },
    })
    .connect({ clientId: actorKey('client') })
  cleanup(() => connection.dispose())

  const delivery = inbox('generate until explicitly stopped')
  const started = waitForEvent<DeliveryRoutedEvent>(
    listener => connection.on('deliveryRouted', listener),
    event => event.id === delivery.id && event.status === 'started',
    { description: 'stoppable run to start' }
  )
  const partialOutput = waitForEvent<FrameEvent>(
    listener => connection.on('frame', listener),
    event => event.chunk.type === 'text-delta',
    { description: 'stoppable run output' }
  )
  await connection.deliver(delivery)
  const runId = (await started).runId
  if (!runId) throw new Error('Missing stoppable run id')
  await partialOutput

  const cancelled = waitForEvent<StatusChangedEvent>(
    listener => connection.on('statusChanged', listener),
    event => event.runId === runId && event.runStatus === 'cancelled',
    { description: 'stopped run to become cancelled' }
  )
  const stopped = await new SessionChatTransport(
    connection
  ).stopActiveRun()
  expect(stopped).toEqual({ cancelled: true, runId })
  await cancelled

  const snapshot = await connection.getSession()
  const stoppedRun = await connection.getRun(runId)
  expect(stoppedRun?.status).toBe('cancelled')
  expect(
    snapshot.messages.map((message: UIMessage) => message.id)
  ).toEqual([delivery.message.id, stoppedRun?.assistantMessageId])
  expect(
    snapshot.messages.filter(
      (message: UIMessage) => message.role === 'user'
    )
  ).toHaveLength(1)
  expect(
    snapshot.messages[1]?.parts.some(
      (part: UIMessage['parts'][number]) =>
        (part.type === 'text' || part.type === 'reasoning') &&
        part.text.length > 0
    )
  ).toBe(true)
}, 20_000)
