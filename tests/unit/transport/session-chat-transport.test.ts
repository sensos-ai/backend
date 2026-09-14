import { describe, expect, test } from 'bun:test'
import type { UIMessage, UIMessageChunk } from 'ai'
import type {
  DeliveryRoutedEvent,
  FrameEvent,
  StatusChangedEvent,
} from '@/runtime/actors/session/config'
import type { RunRow, RunStatus } from '@/runtime/actors/session/db'
import {
  DeferredSessionChatTransport,
  SessionChatTransport,
  type SessionConnection,
} from '@/chat/transport/session-chat-transport'

const userMessage: UIMessage = {
  id: 'message-1',
  role: 'user',
  parts: [{ type: 'text', text: 'Hello' }],
}

const finishChunk: UIMessageChunk = {
  type: 'finish',
  finishReason: 'stop',
}

function run(status: RunStatus, error: string | null = null): RunRow {
  return {
    id: 'run-1',
    idempotencyId: 'request-1',
    model: 'openai/gpt-5.6-sol',
    steps: null,
    totalUsage: null,
    responseMetadata: null,
    userMessageId: userMessage.id,
    assistantMessageId: 'message-2',
    status,
    finishReason: status === 'completed' ? 'stop' : null,
    error,
    createdAt: new Date(),
    startedAt: new Date(),
    finishedAt: status === 'running' ? null : new Date(),
  }
}

class FakeConnection {
  frameListeners = new Set<(event: FrameEvent) => void>()
  statusListeners = new Set<(event: StatusChangedEvent) => void>()
  deliveryListeners = new Set<(event: DeliveryRoutedEvent) => void>()
  cancelled: string[] = []
  sent: unknown[] = []
  activeRunId: string | undefined
  snapshot = {
    run: run('completed'),
    frames: [{ seq: 0, chunk: finishChunk }],
  }
  sendImplementation: () => Promise<{
    accepted: boolean
    deduplicated: boolean
    runId: string
    status: RunStatus
  }> = async () => ({
    accepted: true,
    deduplicated: false,
    runId: 'run-1',
    status: 'queued',
  })

  on(
    event: 'frame' | 'statusChanged' | 'deliveryRouted',
    callback:
      | ((event: FrameEvent) => void)
      | ((event: StatusChangedEvent) => void)
      | ((event: DeliveryRoutedEvent) => void)
  ) {
    const listeners =
      event === 'frame'
        ? this.frameListeners
        : event === 'statusChanged'
          ? this.statusListeners
          : this.deliveryListeners
    listeners.add(callback as never)
    return () => listeners.delete(callback as never)
  }

  async send(name: string, input: unknown, options: unknown) {
    this.sent.push({ name, input, options })
    if (name === 'inbox') {
      const result = await this.sendImplementation()
      const inbox = input as {
        id: string
        origin: DeliveryRoutedEvent['origin']
      }
      queueMicrotask(() =>
        this.emitDelivery({
          id: inbox.id,
          status: result.accepted ? 'started' : 'refused',
          runId: result.runId,
          origin: inbox.origin,
        })
      )
      return { status: 'accepted' as const }
    }
    return {
      status: 'completed' as const,
      response: await this.sendImplementation(),
    }
  }

  async deliver(input: unknown) {
    await this.send('inbox', input, undefined)
    const inbox = input as {
      id: string
      origin: DeliveryRoutedEvent['origin']
    }
    return {
      id: inbox.id,
      status: 'queued' as const,
      origin: inbox.origin,
    }
  }

  async cancel(runId: string) {
    this.cancelled.push(runId)
    return { cancelled: true, runId }
  }

  async getSession() {
    return {
      messages: [userMessage],
      revision: 1,
      runStatus: this.activeRunId
        ? ('running' as const)
        : ('idle' as const),
      status: this.activeRunId
        ? ('streaming' as const)
        : ('ready' as const),
      activeRunId: this.activeRunId,
      model: 'openai/gpt-5.6-sol' as const,
    }
  }

  async streamSnapshot() {
    return this.snapshot
  }

  emitFrame(event: FrameEvent) {
    for (const listener of this.frameListeners) listener(event)
  }

  emitStatus(event: StatusChangedEvent) {
    for (const listener of this.statusListeners) listener(event)
  }

  emitDelivery(event: DeliveryRoutedEvent) {
    for (const listener of this.deliveryListeners) listener(event)
  }
}

function transport(fake: FakeConnection) {
  return new SessionChatTransport(fake as unknown as SessionConnection)
}

async function chunks(stream: ReadableStream<UIMessageChunk>) {
  const result: UIMessageChunk[] = []
  for await (const chunk of stream) result.push(chunk)
  return result
}

describe('SessionChatTransport', () => {
  test('defers submission until the actor connection is ready', async () => {
    const fake = new FakeConnection()
    let resolveConnection: ((value: SessionConnection) => void) | undefined
    const connection = new Promise<SessionConnection>(resolve => {
      resolveConnection = resolve
    })
    const deferred = new DeferredSessionChatTransport(connection)
    const submitted = deferred.sendMessages({
      trigger: 'submit-message',
      chatId: 'chat_one',
      messageId: undefined,
      messages: [userMessage],
      abortSignal: undefined,
    })

    await Promise.resolve()
    expect(fake.sent).toHaveLength(0)
    resolveConnection?.(fake as unknown as SessionConnection)
    await submitted
    expect(fake.sent).toHaveLength(1)
  })

  test('submits the final user message and replays a completed run', async () => {
    const fake = new FakeConnection()
    const value = transport(fake)
    const stream = await value.sendMessages({
      trigger: 'submit-message',
      chatId: 'session-1',
      messageId: undefined,
      messages: [userMessage],
      abortSignal: undefined,
      body: {
        idempotencyId: 'request-requested',
        model: 'openai/gpt-6-astra',
      },
    })

    expect(await chunks(stream)).toEqual([finishChunk])
    expect(fake.sent).toEqual([
      {
        name: 'inbox',
        input: {
          id: 'request-requested',
          priority: 'adaptive',
          message: userMessage,
          createdAt: expect.any(Number),
          origin: { type: 'client', clientId: 'chat-client' },
        },
        options: undefined,
      },
    ])
  })

  test('accepts a queued delivery from the action response without waiting for another event', async () => {
    const fake = new FakeConnection()
    fake.deliver = async input => {
      const inbox = input as {
        id: string
        origin: DeliveryRoutedEvent['origin']
      }
      return {
        id: inbox.id,
        status: 'queued' as const,
        origin: inbox.origin,
      }
    }

    expect(
      await transport(fake).deliverMessage(userMessage, 'next')
    ).toEqual({
      id: expect.any(String),
      status: 'queued',
      origin: { type: 'client', clientId: 'chat-client' },
    })
  })

  test('deduplicates frames received during snapshot replay', async () => {
    const fake = new FakeConnection()
    fake.streamSnapshot = async () => {
      fake.emitFrame({ runId: 'run-1', seq: 0, chunk: finishChunk })
      return fake.snapshot
    }

    const stream = await transport(fake).sendMessages({
      trigger: 'submit-message',
      chatId: 'session-1',
      messageId: undefined,
      messages: [userMessage],
      abortSignal: undefined,
    })

    expect(await chunks(stream)).toEqual([finishChunk])
  })

  test('reconnects to the active run from its durable snapshot', async () => {
    const fake = new FakeConnection()
    fake.activeRunId = 'run-1'
    const stream = await transport(fake).reconnectToStream({
      chatId: 'session-1',
    })

    expect(stream).not.toBeNull()
    if (!stream) throw new Error('Expected an active stream')
    expect(await chunks(stream)).toEqual([finishChunk])
  })

  test('detaches a stream reader without cancelling the actor run', async () => {
    const fake = new FakeConnection()
    fake.snapshot = {
      run: run('running'),
      frames: [
        {
          seq: 0,
          chunk: { type: 'text-start', id: 'text-1' },
        },
      ],
    }
    const value = transport(fake)
    const stream = await value.sendMessages({
      trigger: 'submit-message',
      chatId: 'session-1',
      messageId: undefined,
      messages: [userMessage],
      abortSignal: undefined,
    })

    value.detachActiveStreams()

    expect(await chunks(stream)).toEqual([
      { type: 'text-start', id: 'text-1' },
    ])
    expect(fake.cancelled).toEqual([])
  })

  test('stops the active actor run explicitly', async () => {
    const fake = new FakeConnection()
    fake.activeRunId = 'run-1'

    expect(await transport(fake).stopActiveRun()).toEqual({
      cancelled: true,
      runId: 'run-1',
    })
    expect(fake.cancelled).toEqual(['run-1'])
  })

  test('cancels the resolved run when aborted during submission', async () => {
    const fake = new FakeConnection()
    let resolveSubmit: (() => void) | undefined
    fake.sendImplementation = async () => {
      await new Promise<void>(resolve => {
        resolveSubmit = resolve
      })
      return {
        accepted: true,
        deduplicated: false,
        runId: 'run-1',
        status: 'queued',
      }
    }
    const abortController = new AbortController()
    const pending = transport(fake).sendMessages({
      trigger: 'submit-message',
      chatId: 'session-1',
      messageId: undefined,
      messages: [userMessage],
      abortSignal: abortController.signal,
      body: { model: 'openai/gpt-5.6-sol' },
    })

    abortController.abort()
    resolveSubmit?.()
    const stream = await pending
    await chunks(stream)
    expect(fake.cancelled).toEqual(['run-1'])
  })

  test('errors the stream for a failed terminal run', async () => {
    const fake = new FakeConnection()
    fake.snapshot = { run: run('failed', 'model failed'), frames: [] }
    const stream = await transport(fake).sendMessages({
      trigger: 'submit-message',
      chatId: 'session-1',
      messageId: undefined,
      messages: [userMessage],
      abortSignal: undefined,
    })

    expect(chunks(stream)).rejects.toThrow('model failed')
  })

  test('rejects regeneration without submitting a run', async () => {
    const fake = new FakeConnection()
    expect(
      transport(fake).sendMessages({
        trigger: 'regenerate-message',
        chatId: 'session-1',
        messageId: 'message-2',
        messages: [userMessage],
        abortSignal: undefined,
      })
    ).rejects.toThrow('does not support regeneration')
  })
})
