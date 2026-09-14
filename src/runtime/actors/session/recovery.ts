import {
  readUIMessageStream,
  type UIMessage,
  type UIMessageChunk,
} from 'ai'
import {
  clearActiveRun,
  finalizeRun,
  getRun,
  listMessages,
  listRunFrames,
  type SessionDatabase,
} from './db'
import {
  cutoffAssistantMessage,
  hasAssistantContent,
} from './utils/messages'
import {
  releaseRuntimeActivity,
  runtimeActivityKey,
} from '@/runtime/activity'
import { closeRunStream } from '@/runtime/durable-run-stream'

const terminalStatuses = new Set([
  'cancelled',
  'completed',
  'failed',
  'interrupted',
])

async function replayAssistantMessage(
  frames: Awaited<ReturnType<typeof listRunFrames>>
): Promise<UIMessage | undefined> {
  let snapshot: UIMessage | undefined
  const snapshots = readUIMessageStream({
    stream: new ReadableStream<UIMessageChunk>({
      start(controller) {
        for (const frame of frames) controller.enqueue(frame.chunk)
        controller.close()
      },
    }),
  })
  for await (const next of snapshots) snapshot = next
  return hasAssistantContent(snapshot) ? snapshot : undefined
}

export type OrphanedRunRecovery =
  | { recovered: false; runId?: string }
  | {
      recovered: true
      runId: string
      status: 'cancelled' | 'interrupted'
      revision: number
      messages: UIMessage[]
      sequence: number
      chunk: UIMessageChunk
    }

export async function recoverOrphanedActiveRun(input: {
  database: SessionDatabase
  activeRunId: string | null | undefined
  liveRunId?: string
}): Promise<OrphanedRunRecovery> {
  const runId = input.activeRunId ?? undefined
  if (!runId || input.liveRunId === runId) {
    return { recovered: false, ...(runId ? { runId } : {}) }
  }

  const run = await getRun(input.database, runId)
  if (!run) {
    await clearActiveRun(input.database, runId)
    return { recovered: false, runId }
  }
  if (terminalStatuses.has(run.status)) {
    await clearActiveRun(input.database, runId)
    releaseRuntimeActivity(runtimeActivityKey(run.idempotencyId))
    return { recovered: false, runId }
  }
  if (run.status === 'queued') {
    return { recovered: false, runId }
  }

  const frames = await listRunFrames(input.database, runId)
  const sequence = (frames.at(-1)?.seq ?? -1) + 1
  const status =
    run.status === 'cancel_requested' ? 'cancelled' : 'interrupted'
  const chunk: UIMessageChunk = {
    type: 'abort',
    reason:
      status === 'cancelled'
        ? 'cancelled during recovery'
        : 'runtime restarted',
  }
  const replayed = await replayAssistantMessage(frames)
  const finalized = await finalizeRun(input.database, runId, {
    status,
    sequence,
    chunk,
    ...(replayed
      ? {
          responseMessage: cutoffAssistantMessage(
            run.assistantMessageId,
            replayed,
            status === 'cancelled' ? '[Stopped]' : '[Interrupted]'
          ),
        }
      : {}),
  })
  await closeRunStream(runId, chunk).catch(() => undefined)
  releaseRuntimeActivity(runtimeActivityKey(run.idempotencyId))
  return {
    recovered: true,
    runId,
    status,
    revision: finalized.revision,
    messages: await listMessages(input.database),
    sequence,
    chunk,
  }
}
