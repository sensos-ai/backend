import type {
  ChatTransport,
  GatewayModelId,
  UIMessage,
  UIMessageChunk,
} from 'ai'
import type { Offset } from '@durable-streams/client'
import type { ActorConn } from 'rivetkit/client'
import type { HarnessFeatures } from '@/chat/harness'
import type {
  DeliveryRoutedEvent,
  InboxMessage,
  RunCommand,
  RunCompletion,
  StatusChangedEvent,
} from '@/runtime/actors/session/config'
import type { SessionActor } from '@/runtime/actors/session/types'
import {
  readRunStream,
  type RunStreamItem,
} from '@/runtime/durable-run-stream'
import { createIdGeneratorWithPrefix } from '@/shared/utils'

export type SessionConnection = ActorConn<SessionActor>

export type SessionSnapshot = {
  messages: UIMessage[]
  revision: number
  runStatus: StatusChangedEvent['runStatus']
  status: StatusChangedEvent['status']
  activeRunId?: string
  model?: GatewayModelId
  features: HarnessFeatures
  title?: string
  error?: string
}

type SessionTransportConnection = {
  send(
    name: 'runs',
    input: RunCommand,
    options: { wait: true; timeout: number; signal?: AbortSignal }
  ): Promise<{
    status: 'completed' | 'timedOut'
    response?: RunCompletion
  }>
  send(name: 'inbox', input: InboxMessage): Promise<unknown>
  deliver(input: InboxMessage): Promise<DeliveryRoutedEvent>
  cancel(runId: string): Promise<{ cancelled: boolean; runId: string }>
  getSession(): Promise<SessionSnapshot>
  on(
    event: 'titleChanged',
    callback: (event: { title: string }) => void
  ): () => void
  on(
    event: 'deliveryRouted',
    callback: (event: DeliveryRoutedEvent) => void
  ): () => void
}

const createIdempotencyId = createIdGeneratorWithPrefix('request')

type SessionChatRequestBody = {
  idempotencyId?: string
  model?: GatewayModelId
  priority?: InboxMessage['priority']
}

function requestBody(body: object | undefined): SessionChatRequestBody {
  return (body ?? {}) as SessionChatRequestBody
}

function getFinalUserMessage(messages: UIMessage[]): UIMessage {
  const message = messages.findLast(candidate => candidate.role === 'user')
  if (!message)
    throw new Error('Cannot submit chat without a user message')
  return message
}

type StreamBridge = {
  stream: ReadableStream<UIMessageChunk>
  read(runId: string, offset: Offset): void
  fail(error: unknown): void
  close(): void
  addCleanup(cleanup: () => void): void
}

export type RunStreamReader = (options: {
  runId: string
  offset?: Offset
  signal?: AbortSignal
}) => AsyncIterable<RunStreamItem>

function createStreamBridge(
  readStream: RunStreamReader,
  onOffset: (runId: string, offset: Offset) => void
): StreamBridge {
  let controller: ReadableStreamDefaultController<UIMessageChunk>
  let settled = false
  const readController = new AbortController()
  const extraCleanups: Array<() => void> = []

  const cleanup = () => {
    readController.abort('stream reader detached')
    for (const cleanup of extraCleanups) cleanup()
  }
  const close = () => {
    if (settled) return
    settled = true
    cleanup()
    controller.close()
  }
  const fail = (error: unknown) => {
    if (settled) return
    settled = true
    cleanup()
    controller.error(error)
  }
  const stream = new ReadableStream<UIMessageChunk>({
    start(value) {
      controller = value
    },
    cancel() {
      if (!settled) {
        settled = true
        cleanup()
      }
    },
  })

  return {
    stream,
    read(runId, offset) {
      void (async () => {
        try {
          for await (const item of readStream({
            runId,
            offset,
            signal: readController.signal,
          })) {
            if (settled) return
            controller.enqueue(item.chunk)
            if (item.offset !== undefined) onOffset(runId, item.offset)
          }
          close()
        } catch (error) {
          if (!settled && !readController.signal.aborted) fail(error)
        }
      })()
    },
    fail,
    close,
    addCleanup(cleanup) {
      extraCleanups.push(cleanup)
    },
  }
}

/** Loads the durable transcript and current session state for initial hydration. */
export function getSessionSnapshot(
  connection: SessionConnection
): Promise<SessionSnapshot> {
  return connection.getSession()
}

/** AI SDK v7 chat transport backed by one connected Rivet session actor. */
export class SessionChatTransport<UI_MESSAGE extends UIMessage = UIMessage>
  implements ChatTransport<UI_MESSAGE>
{
  readonly #connection: SessionTransportConnection
  readonly #clientId: string
  readonly #readStream: RunStreamReader
  readonly #activeBridges = new Set<StreamBridge>()
  readonly #lastSeenOffset = new Map<string, Offset>()

  constructor(
    connection: SessionConnection,
    options: {
      clientId?: string
      readStream?: RunStreamReader
    } = {}
  ) {
    this.#connection = connection
    this.#clientId = options.clientId ?? 'chat-client'
    this.#readStream = options.readStream ?? readRunStream
  }

  async deliverMessage(
    message: UIMessage,
    priority: InboxMessage['priority'] = 'adaptive',
    options: {
      id?: string
      signal?: AbortSignal
      waitForStart?: boolean
    } = {}
  ): Promise<DeliveryRoutedEvent> {
    const id = options.id ?? createIdempotencyId()
    let cleanup = () => {}
    const receipt = new Promise<DeliveryRoutedEvent>((resolve, reject) => {
      let settled = false
      const finish = (result: DeliveryRoutedEvent) => {
        if (
          settled ||
          (options.waitForStart && result.status === 'queued')
        ) {
          return
        }
        settled = true
        cleanup()
        resolve(result)
      }
      const fail = (error: Error) => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }
      const unsubscribe = this.#connection.on('deliveryRouted', result => {
        if (result.id === id) finish(result)
      })
      const timer = setTimeout(
        () => fail(new Error('Timed out waiting for inbox routing')),
        10_000
      )
      const onAbort = () => fail(new Error('Inbox delivery aborted'))
      cleanup = () => {
        clearTimeout(timer)
        unsubscribe()
        options.signal?.removeEventListener('abort', onAbort)
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })
      if (options.signal?.aborted) onAbort()
    })

    try {
      const routed = await this.#connection.deliver({
        id,
        priority,
        message,
        createdAt: Date.now(),
        origin: { type: 'client', clientId: this.#clientId },
      })
      if (!options.waitForStart || routed.status !== 'queued') {
        cleanup()
        return routed
      }
    } catch (error) {
      cleanup()
      throw error
    }
    return receipt
  }

  async sendMessages({
    trigger,
    messages,
    abortSignal,
    body,
  }: Parameters<ChatTransport<UI_MESSAGE>['sendMessages']>[0]): Promise<
    ReadableStream<UIMessageChunk>
  > {
    if (trigger === 'regenerate-message') {
      throw new Error('SessionChatTransport does not support regeneration')
    }

    const bridge = this.#createBridge()
    let runId: string | undefined
    let aborted = abortSignal?.aborted ?? false
    const onAbort = () => {
      aborted = true
      if (runId) void this.#connection.cancel(runId).catch(bridge.fail)
    }
    abortSignal?.addEventListener('abort', onAbort, { once: true })
    bridge.addCleanup(() =>
      abortSignal?.removeEventListener('abort', onAbort)
    )

    try {
      const request = requestBody(body)
      const result = await this.deliverMessage(
        getFinalUserMessage(messages),
        request.priority ?? 'adaptive',
        {
          id: request.idempotencyId,
          waitForStart: true,
        }
      )
      if (result.status === 'refused' || !result.runId) {
        throw new Error(
          result.reason === 'waiting_for_input'
            ? 'Immediate steering is unavailable while the session is waiting for input'
            : result.reason === 'session_busy'
              ? 'The session is still processing another turn'
              : result.reason === 'not_active'
                ? 'The active run ended before the message could be delivered'
                : 'The session could not start this message'
        )
      }
      runId = result.runId

      if (aborted) await this.#connection.cancel(runId)
      bridge.read(runId, '-1')
    } catch (error) {
      bridge.fail(error)
    }

    return bridge.stream
  }

  async reconnectToStream({
    abortSignal,
  }: Parameters<
    ChatTransport<UI_MESSAGE>['reconnectToStream']
  >[0]): Promise<ReadableStream<UIMessageChunk> | null> {
    const bridge = this.#createBridge()
    const onAbort = () => bridge.close()
    abortSignal?.addEventListener('abort', onAbort, { once: true })
    bridge.addCleanup(() =>
      abortSignal?.removeEventListener('abort', onAbort)
    )

    try {
      if (abortSignal?.aborted) {
        bridge.close()
        return bridge.stream
      }
      const session = await this.#connection.getSession()
      if (!session.activeRunId) {
        bridge.close()
        return null
      }
      bridge.read(
        session.activeRunId,
        this.#lastSeenOffset.get(session.activeRunId) ?? '-1'
      )
      return bridge.stream
    } catch (error) {
      bridge.fail(error)
      return bridge.stream
    }
  }

  detachActiveStreams(): void {
    for (const bridge of this.#activeBridges) bridge.close()
  }

  async stopActiveRun(): Promise<{ cancelled: boolean; runId?: string }> {
    const session = await this.#connection.getSession()
    if (!session.activeRunId) return { cancelled: false }
    return this.#connection.cancel(session.activeRunId)
  }

  #createBridge(): StreamBridge {
    const bridge = createStreamBridge(
      this.#readStream,
      (runId, offset) => {
        this.#lastSeenOffset.set(runId, offset)
      }
    )
    this.#activeBridges.add(bridge)
    bridge.addCleanup(() => this.#activeBridges.delete(bridge))
    return bridge
  }
}

/** Defers actor access so the terminal can accept input during runtime startup. */
export class DeferredSessionChatTransport<
  UI_MESSAGE extends UIMessage = UIMessage,
> implements ChatTransport<UI_MESSAGE>
{
  readonly #transport: Promise<SessionChatTransport<UI_MESSAGE>>

  constructor(
    connection: Promise<SessionConnection>,
    options: ConstructorParameters<typeof SessionChatTransport>[1] = {}
  ) {
    this.#transport = connection.then(
      value => new SessionChatTransport<UI_MESSAGE>(value, options)
    )
  }

  async sendMessages(
    options: Parameters<ChatTransport<UI_MESSAGE>['sendMessages']>[0]
  ): Promise<ReadableStream<UIMessageChunk>> {
    return (await this.#transport).sendMessages(options)
  }

  async deliverMessage(
    message: UIMessage,
    priority: InboxMessage['priority'] = 'adaptive',
    options?: Parameters<SessionChatTransport['deliverMessage']>[2]
  ) {
    return (await this.#transport).deliverMessage(
      message,
      priority,
      options
    )
  }

  async reconnectToStream(
    options: Parameters<ChatTransport<UI_MESSAGE>['reconnectToStream']>[0]
  ): Promise<ReadableStream<UIMessageChunk> | null> {
    return (await this.#transport).reconnectToStream(options)
  }

  async stopActiveRun() {
    return (await this.#transport).stopActiveRun()
  }

  detachActiveStreams(): void {
    void this.#transport.then(value => value.detachActiveStreams())
  }
}
