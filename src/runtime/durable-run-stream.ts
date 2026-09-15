import {
  DurableStream,
  DurableStreamError,
  StreamClosedError,
  stream as readDurableStream,
  type JsonBatch,
  type Offset,
} from '@durable-streams/client'
import type { UIMessageChunk } from 'ai'
import { RUNTIME_STREAMS_ENDPOINT } from './constants'
import { recordTiming } from '@/shared/timing'

const RUN_STREAM_CONTENT_TYPE = 'application/json'

function streamsEndpoint(override?: string): string {
  return (
    override ??
    process.env.RIVET_TEST_STREAMS_ENDPOINT ??
    RUNTIME_STREAMS_ENDPOINT
  )
}

export function runStreamUrl(runId: string, endpoint?: string): string {
  return `${streamsEndpoint(endpoint)}/durable-streams/v1/stream/sensos/runs/${encodeURIComponent(runId)}`
}

function runStream(runId: string): DurableStream {
  return new DurableStream({
    url: runStreamUrl(runId),
    contentType: RUN_STREAM_CONTENT_TYPE,
  })
}

export async function ensureRunStream(runId: string): Promise<void> {
  const output = runStream(runId)
  const metadata = await output.head()
  if (metadata.exists) return

  try {
    await output.create({ contentType: RUN_STREAM_CONTENT_TYPE })
  } catch (error) {
    if (
      !(
        error instanceof DurableStreamError &&
        error.code === 'CONFLICT_EXISTS'
      )
    ) {
      throw error
    }
  }
}

export async function appendRunStreamChunk(
  runId: string,
  sequence: number,
  chunk: UIMessageChunk
): Promise<void> {
  await runStream(runId).append(JSON.stringify(chunk), {
    seq: sequence.toString().padStart(16, '0'),
  })
}

export async function closeRunStream(
  runId: string,
  chunk: UIMessageChunk
): Promise<void> {
  try {
    await runStream(runId).close({ body: JSON.stringify(chunk) })
  } catch (error) {
    if (!(error instanceof StreamClosedError)) throw error
  }
}

export type RunStreamItem = {
  chunk: UIMessageChunk
  offset?: Offset
}

export async function* readRunStream(options: {
  runId: string
  offset?: Offset
  signal?: AbortSignal
  endpoint?: string
}): AsyncGenerator<RunStreamItem> {
  const startedAt = Date.now()
  recordTiming('client.stream.connect_start', { runId: options.runId })
  const response = await readDurableStream<UIMessageChunk>({
    url: runStreamUrl(options.runId, options.endpoint),
    offset: options.offset ?? '-1',
    live: 'sse',
    signal: options.signal,
  })

  const batches: JsonBatch<UIMessageChunk>[] = []
  let wake: (() => void) | undefined
  let finished = false
  let failure: unknown
  let receivedChunk = false
  const notify = () => {
    wake?.()
    wake = undefined
  }
  const unsubscribe = response.subscribeJson(batch => {
    batches.push(batch)
    notify()
  })
  void response.closed.then(
    () => {
      finished = true
      notify()
    },
    error => {
      failure = error
      finished = true
      notify()
    }
  )

  try {
    for (;;) {
      const batch = batches.shift()
      if (!batch) {
        if (failure) throw failure
        if (finished) {
          recordTiming('client.stream.closed', {
            runId: options.runId,
            elapsedMs: Date.now() - startedAt,
          })
          return
        }
        await new Promise<void>(resolve => {
          wake = resolve
        })
        continue
      }

      for (const [index, chunk] of batch.items.entries()) {
        if (!receivedChunk) {
          receivedChunk = true
          recordTiming('client.stream.first_chunk', {
            runId: options.runId,
            elapsedMs: Date.now() - startedAt,
          })
        }
        yield {
          chunk,
          ...(index === batch.items.length - 1
            ? { offset: batch.offset }
            : {}),
        }
      }
    }
  } finally {
    unsubscribe()
  }
}

export function createRunStreamReader(endpoint: string) {
  return (options: {
    runId: string
    offset?: Offset
    signal?: AbortSignal
  }) => readRunStream({ ...options, endpoint })
}
