import type {
  ChatTransport,
  GatewayModelId,
  UIMessage,
  UIMessageChunk,
} from 'ai'
import type { ActorConn } from 'rivetkit/client'
import type { HarnessFeatures } from '@/chat/harness'
import type { RunRow } from '@/runtime/actors/session/db'
import type {
  FrameEvent,
  RunCommand,
  RunCompletion,
  StatusChangedEvent,
} from '@/runtime/actors/session/config'
import type { SessionActor } from '@/runtime/actors/session/types'
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

type RunSnapshot = {
  run: RunRow | undefined
  frames: Array<Pick<FrameEvent, 'seq' | 'chunk'>>
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
  cancel(runId: string): Promise<{ cancelled: boolean; runId: string }>
  getSession(): Promise<SessionSnapshot>
  streamSnapshot(runId: string, afterSeq?: number): Promise<RunSnapshot>
  on(event: 'frame', callback: (event: FrameEvent) => void): () => void
  on(
    event: 'statusChanged',
    callback: (event: StatusChangedEvent) => void
  ): () => void
  on(
    event: 'titleChanged',
    callback: (event: { title: string }) => void
  ): () => void
}

const terminalStatuses = new Set<RunRow['status']>([
  'cancelled',
  'completed',
  'failed',
  'interrupted',
])

function runError(status: RunRow['status'], error?: string) {
  return new Error(error ?? `Session run ${status}`)
}

const createIdempotencyId = createIdGeneratorWithPrefix('request')

type SessionChatRequestBody = {
  idempotencyId?: string
  model?: GatewayModelId
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
  setRunId(runId: string): void
  replay(snapshot: RunSnapshot): void
  fail(error: unknown): void
  close(): void
  addCleanup(cleanup: () => void): void
}

function createStreamBridge(
  connection: SessionTransportConnection
): StreamBridge {
  let controller: ReadableStreamDefaultController<UIMessageChunk>
  let runId: string | undefined
  let replayed = false
  let settled = false
  const seen = new Set<string>()
  const pendingFrames: FrameEvent[] = []
  const pendingStatuses: StatusChangedEvent[] = []
  const extraCleanups: Array<() => void> = []

  const cleanup = () => {
    unsubscribeFrame()
    unsubscribeStatus()
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
  const emitFrame = (frame: FrameEvent) => {
    if (settled || frame.runId !== runId) return
    const key = `${frame.runId}:${frame.seq}`
    if (seen.has(key)) return
    seen.add(key)
    controller.enqueue(frame.chunk)
  }
  const emitStatus = (event: StatusChangedEvent) => {
    if (settled || event.runId !== runId) return
    if (
      event.runStatus === 'completed' ||
      event.runStatus === 'cancelled'
    ) {
      close()
    } else if (
      event.runStatus === 'failed' ||
      event.runStatus === 'interrupted'
    ) {
      fail(runError(event.runStatus, event.error))
    }
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

  const unsubscribeFrame = connection.on('frame', event => {
    if (!replayed) pendingFrames.push(event)
    else emitFrame(event)
  })
  const unsubscribeStatus = connection.on('statusChanged', event => {
    if (!replayed) pendingStatuses.push(event)
    else emitStatus(event)
  })

  return {
    stream,
    setRunId(value) {
      runId = value
    },
    replay(snapshot) {
      if (settled) return
      for (const frame of snapshot.frames.toSorted(
        (a, b) => a.seq - b.seq
      )) {
        emitFrame({ runId: runId ?? '', ...frame })
      }
      replayed = true
      for (const frame of pendingFrames.toSorted(
        (a, b) => a.seq - b.seq
      )) {
        emitFrame(frame)
      }
      for (const status of pendingStatuses) emitStatus(status)
      pendingFrames.length = 0
      pendingStatuses.length = 0

      if (
        !settled &&
        snapshot.run &&
        terminalStatuses.has(snapshot.run.status)
      ) {
        if (
          snapshot.run.status === 'failed' ||
          snapshot.run.status === 'interrupted'
        ) {
          fail(
            runError(snapshot.run.status, snapshot.run.error ?? undefined)
          )
        } else {
          close()
        }
      }
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

  constructor(connection: SessionConnection) {
    this.#connection = connection
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

    const bridge = createStreamBridge(this.#connection)
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
      const queued = await this.#connection.send(
        'runs',
        {
          idempotencyId: request.idempotencyId ?? createIdempotencyId(),
          model:
            request.model ?? (await this.#connection.getSession()).model,
          message: getFinalUserMessage(messages),
        },
        { wait: true, timeout: 10_000, signal: abortSignal }
      )
      if (queued.status === 'timedOut' || !queued.response) {
        throw new Error('Timed out waiting for session run submission')
      }
      const result = queued.response
      runId = result.runId
      bridge.setRunId(runId)

      if (!result.accepted) {
        bridge.fail(new Error('Session already has an active run'))
        return bridge.stream
      }

      if (aborted) await this.#connection.cancel(runId)
      bridge.replay(await this.#connection.streamSnapshot(runId, -1))
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
    const bridge = createStreamBridge(this.#connection)
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
      bridge.setRunId(session.activeRunId)
      bridge.replay(
        await this.#connection.streamSnapshot(session.activeRunId, -1)
      )
      return bridge.stream
    } catch (error) {
      bridge.fail(error)
      return bridge.stream
    }
  }
}

/** Defers actor access so the terminal can accept input during runtime startup. */
export class DeferredSessionChatTransport<
  UI_MESSAGE extends UIMessage = UIMessage,
> implements ChatTransport<UI_MESSAGE>
{
  readonly #transport: Promise<SessionChatTransport<UI_MESSAGE>>

  constructor(connection: Promise<SessionConnection>) {
    this.#transport = connection.then(
      value => new SessionChatTransport<UI_MESSAGE>(value)
    )
  }

  async sendMessages(
    options: Parameters<ChatTransport<UI_MESSAGE>['sendMessages']>[0]
  ): Promise<ReadableStream<UIMessageChunk>> {
    return (await this.#transport).sendMessages(options)
  }

  async reconnectToStream(
    options: Parameters<ChatTransport<UI_MESSAGE>['reconnectToStream']>[0]
  ): Promise<ReadableStream<UIMessageChunk> | null> {
    return (await this.#transport).reconnectToStream(options)
  }
}
