import { describe, expect, test } from 'bun:test'
import type { UIMessage, UIMessageChunk } from 'ai'
import type { DeliveryRoutedEvent } from '@/runtime/actors/session/config'
import {
  DeferredSessionChatTransport,
  SessionChatTransport,
  type SessionConnection,
} from '@/chat/transport/session-chat-transport'
import type { RunStreamItem } from '@/runtime/durable-run-stream'

const userMessage: UIMessage = {
  id: 'message-1',
  role: 'user',
  parts: [{ type: 'text', text: 'Hello' }],
}

const finishChunk: UIMessageChunk = {
  type: 'finish',
  finishReason: 'stop',
}

class FakeConnection {
  deliveryListeners = new Set<(event: DeliveryRoutedEvent) => void>()
  cancelled: string[] = []
  sent: unknown[] = []
  activeRunId: string | undefined
  sendImplementation: () => Promise<{
    accepted: boolean
    deduplicated: boolean
    runId: string
    status: 'queued'
  }> = async () => ({
    accepted: true,
    deduplicated: false,
    runId: 'run-1',
    status: 'queued',
  })

  on(
    _event: 'deliveryRouted',
    callback: (event: DeliveryRoutedEvent) => void
  ) {
    this.deliveryListeners.add(callback)
    return () => this.deliveryListeners.delete(callback)
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

  emitDelivery(event: DeliveryRoutedEvent) {
    for (const listener of this.deliveryListeners) listener(event)
  }
}

class FakeRunStreams {
  calls: Array<{ runId: string; offset?: string }> = []
  reads: RunStreamItem[][] = [[{ chunk: finishChunk, offset: '0' }]]

  read = async function* (
    this: FakeRunStreams,
    options: { runId: string; offset?: string; signal?: AbortSignal }
  ) {
    this.calls.push({ runId: options.runId, offset: options.offset })
    for (const item of this.reads.shift() ?? []) yield item
  }.bind(this)
}

function transport(fake: FakeConnection, streams = new FakeRunStreams()) {
  return new SessionChatTransport(fake as unknown as SessionConnection, {
    readStream: streams.read,
  })
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
    const streams = new FakeRunStreams()
    const deferred = new DeferredSessionChatTransport(connection, {
      readStream: streams.read,
    })
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

  test('reconnects to the active run from the start of its durable stream', async () => {
    const fake = new FakeConnection()
    fake.activeRunId = 'run-1'
    const streams = new FakeRunStreams()
    const stream = await transport(fake, streams).reconnectToStream({
      chatId: 'session-1',
    })

    expect(stream).not.toBeNull()
    if (!stream) throw new Error('Expected an active stream')
    expect(await chunks(stream)).toEqual([finishChunk])
    expect(streams.calls).toEqual([{ runId: 'run-1', offset: '-1' }])
  })

  test('reconnects from the last durable stream offset', async () => {
    const fake = new FakeConnection()
    fake.activeRunId = 'run-1'
    const streams = new FakeRunStreams()
    streams.reads = [
      [
        {
          chunk: { type: 'text-start', id: 'text-1' },
          offset: 'offset-1',
        },
      ],
      [
        {
          chunk: {
            type: 'text-delta',
            id: 'text-1',
            delta: 'continued',
          },
          offset: 'offset-2',
        },
        { chunk: finishChunk, offset: 'offset-3' },
      ],
    ]
    const value = transport(fake, streams)
    const initial = await value.reconnectToStream({ chatId: 'session-1' })
    expect(initial).not.toBeNull()
    if (!initial) throw new Error('Expected an initial stream')
    const initialReader = initial.getReader()
    expect((await initialReader.read()).value).toEqual({
      type: 'text-start',
      id: 'text-1',
    })
    value.detachActiveStreams()
    expect((await initialReader.read()).done).toBe(true)

    const resumed = await value.reconnectToStream({ chatId: 'session-1' })
    expect(resumed).not.toBeNull()
    if (!resumed) throw new Error('Expected a resumed stream')
    expect(await chunks(resumed)).toEqual([
      { type: 'text-delta', id: 'text-1', delta: 'continued' },
      finishChunk,
    ])
    expect(streams.calls).toEqual([
      { runId: 'run-1', offset: '-1' },
      { runId: 'run-1', offset: 'offset-1' },
    ])
  })

  test('detaches a stream reader without cancelling the actor run', async () => {
    const fake = new FakeConnection()
    const streams = new FakeRunStreams()
    streams.reads = [
      [
        {
          chunk: { type: 'text-start', id: 'text-1' },
          offset: 'offset-1',
        },
      ],
    ]
    const value = transport(fake, streams)
    const stream = await value.sendMessages({
      trigger: 'submit-message',
      chatId: 'session-1',
      messageId: undefined,
      messages: [userMessage],
      abortSignal: undefined,
    })

    const reader = stream.getReader()
    expect((await reader.read()).value).toEqual({
      type: 'text-start',
      id: 'text-1',
    })
    value.detachActiveStreams()

    expect((await reader.read()).done).toBe(true)
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

  test('errors the stream when durable replay fails', async () => {
    const fake = new FakeConnection()
    const streams = new FakeRunStreams()
    streams.read = async function* () {
      yield* [] as RunStreamItem[]
      throw new Error('durable stream failed')
    }
    const stream = await transport(fake, streams).sendMessages({
      trigger: 'submit-message',
      chatId: 'session-1',
      messageId: undefined,
      messages: [userMessage],
      abortSignal: undefined,
    })

    expect(chunks(stream)).rejects.toThrow('durable stream failed')
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
