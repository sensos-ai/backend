import '../../setup'
import { expect, onTestFinished, test } from 'bun:test'
import type { UIMessage, UIMessageChunk } from 'ai'
import { setup } from 'rivetkit'
import { setupTest } from 'rivetkit/test'
import { SessionChatTransport } from '@/chat/transport'
import { sessionAgent } from '@/runtime/actors/session'
import type {
  DeliveryRoutedEvent,
  FrameEvent,
  InboxMessage,
  StatusChangedEvent,
} from '@/runtime/actors/session/config'
import { createIdGeneratorWithPrefix } from '@/shared/utils'

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

async function collect(stream: ReadableStream<UIMessageChunk>) {
  const chunks: UIMessageChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

test('active streams survive disconnect and explicit stop persists only the cutoff', async () => {
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

  const resumableHandle = client.session.getOrCreate([createTestId()], {
    createWithInput: { cwd: process.cwd() },
  })
  const firstConnection = resumableHandle.connect({
    clientId: createTestId(),
  })
  const delivery = inbox('keep generating after the client disconnects')
  const started = waitForEvent<DeliveryRoutedEvent>(
    listener => firstConnection.on('deliveryRouted', listener),
    event => event.id === delivery.id && event.status === 'started'
  )
  const firstFrame = waitForEvent<FrameEvent>(
    listener => firstConnection.on('frame', listener),
    event => event.chunk.type === 'text-delta'
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

  await Bun.sleep(150)
  const resumedConnection = resumableHandle.connect({
    clientId: createTestId(),
  })
  const resumedTransport = new SessionChatTransport(resumedConnection)
  const queuedStarted = waitForEvent<DeliveryRoutedEvent>(
    listener => resumedConnection.on('deliveryRouted', listener),
    event => event.id === queuedDelivery.id && event.status === 'started'
  )
  const resumed = await resumedTransport.reconnectToStream({
    chatId: 'resumed-chat',
  })
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
  const queuedDeadline = Date.now() + 10_000
  while (
    (await resumedConnection.getRun(queuedRunId))?.status !== 'completed'
  ) {
    if (Date.now() >= queuedDeadline) {
      throw new Error('Timed out waiting for queued run after reconnect')
    }
    await Bun.sleep(25)
  }
  const resumedMessages = (await resumedConnection.getSession()).messages
  expect(resumedMessages.map((message: UIMessage) => message.id)).toEqual([
    delivery.message.id,
    (await resumedConnection.getRun(runId))?.assistantMessageId,
    queuedDelivery.message.id,
    (await resumedConnection.getRun(queuedRunId))?.assistantMessageId,
  ])

  const stoppableHandle = client.session.getOrCreate([createTestId()], {
    createWithInput: { cwd: process.cwd() },
  })
  const stoppableConnection = stoppableHandle.connect({
    clientId: createTestId(),
  })
  const stopDelivery = inbox('generate until explicitly stopped')
  const stopStarted = waitForEvent<DeliveryRoutedEvent>(
    listener => stoppableConnection.on('deliveryRouted', listener),
    event => event.id === stopDelivery.id && event.status === 'started'
  )
  const partialOutput = waitForEvent<FrameEvent>(
    listener => stoppableConnection.on('frame', listener),
    event => event.chunk.type === 'text-delta'
  )
  await stoppableConnection.deliver(stopDelivery)
  const stoppedRunId = (await stopStarted).runId
  if (!stoppedRunId) throw new Error('Missing stoppable run id')
  await partialOutput
  const cancelled = waitForEvent<StatusChangedEvent>(
    listener => stoppableConnection.on('statusChanged', listener),
    event =>
      event.runId === stoppedRunId && event.runStatus === 'cancelled'
  )
  const stopped = await new SessionChatTransport(
    stoppableConnection
  ).stopActiveRun()
  expect(stopped).toEqual({ cancelled: true, runId: stoppedRunId })
  await cancelled

  const snapshot = await stoppableConnection.getSession()
  const stoppedRun = await stoppableConnection.getRun(stoppedRunId)
  const ids = snapshot.messages.map((message: UIMessage) => message.id)
  expect(stoppedRun?.status).toBe('cancelled')
  expect(ids).toEqual([
    stopDelivery.message.id,
    stoppedRun?.assistantMessageId,
  ])
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

  await resumedConnection.dispose()
  await stoppableConnection.dispose()
}, 30_000)
