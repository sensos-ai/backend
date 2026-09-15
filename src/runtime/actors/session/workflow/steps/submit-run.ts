import type { UIMessage } from 'ai'
import { createIdGeneratorWithPrefix } from '@/shared/utils'
import { configuredSessionCatalog } from '@/storage/session-catalog'
import {
  toChatStatus,
  type InboxMessage,
  type RunCompletion,
} from '../../config'
import { listMessages, submitRun as submitRunToDatabase } from '../../db'
import type { NextWork, SessionWorkflowContext } from '../types'
import {
  releaseRuntimeActivity,
  retainRuntimeActivity,
  runtimeActivityKey,
} from '@/runtime/activity'
import { ensureRunStream } from '@/runtime/durable-run-stream'
import { recordTiming } from '@/shared/timing'

const createMessageId = createIdGeneratorWithPrefix('msg')
const createRunId = createIdGeneratorWithPrefix('run')

async function projectTranscript(
  sessionId: string,
  revision: number,
  messages: UIMessage[],
  log: { warn: (value: unknown) => void }
): Promise<void> {
  try {
    await configuredSessionCatalog()?.replaceMessages(
      sessionId,
      revision,
      messages
    )
  } catch (error) {
    log.warn({
      msg: 'local transcript projection failed',
      sessionId,
      revision,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

export async function submitRun(
  context: SessionWorkflowContext
): Promise<NextWork> {
  const queued = await context.queue.next('next-run', {
    names: ['runs'],
    completable: true,
  })
  const activityKey = runtimeActivityKey(queued.body.idempotencyId)
  retainRuntimeActivity(activityKey)
  const submission = await context.step('submit-run', async step => {
    const startedAt = Date.now()
    const result = await submitRunToDatabase(step.db, {
      runId: createRunId(),
      idempotencyId: queued.body.idempotencyId,
      model: queued.body.model,
      message: queued.body.message,
      assistantMessageId: createMessageId(),
    })

    const streamStartedAt = Date.now()
    await ensureRunStream(result.run.id)
    recordTiming('actor.stream.created', {
      sessionId: step.state.sessionId,
      runId: result.run.id,
      elapsedMs: Date.now() - streamStartedAt,
    })

    if (result.created) {
      const catalog = configuredSessionCatalog()
      if (catalog) step.waitUntil(catalog.touch(step.state.sessionId))
      const messages = await listMessages(step.db)
      await projectTranscript(
        step.state.sessionId,
        result.revision,
        messages,
        step.log
      )
      step.broadcast('messagesChanged', {
        messages,
        revision: result.revision,
      })
      step.broadcast('statusChanged', {
        runId: result.run.id,
        runStatus: 'queued',
        status: toChatStatus('queued'),
      })
    }

    step.broadcast('deliveryRouted', {
      id: queued.body.idempotencyId,
      status: result.accepted ? 'started' : 'refused',
      runId: result.run.id,
      ...(!result.accepted ? { reason: 'session_busy' as const } : {}),
      origin: ((
        queued.body.message.metadata as Record<string, unknown> | undefined
      )?.sensosOrigin as InboxMessage['origin'] | undefined) ?? {
        type: 'system' as const,
      },
    })
    recordTiming('actor.run.submitted', {
      sessionId: step.state.sessionId,
      runId: result.run.id,
      requestId: queued.body.idempotencyId,
      elapsedMs: Date.now() - startedAt,
    })

    return {
      accepted: result.accepted,
      deduplicated: result.accepted && !result.created,
      runId: result.run.id,
      status: result.run.status,
      ...(!result.accepted ? { reason: 'session_busy' as const } : {}),
    } satisfies RunCompletion
  })

  await queued.complete(submission)
  if (!submission.accepted || submission.deduplicated) {
    releaseRuntimeActivity(activityKey)
  }
  return { kind: 'run', command: queued.body, submission }
}
