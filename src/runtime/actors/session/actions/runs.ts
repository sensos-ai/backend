import { toChatStatus } from '../config'
import {
  finalizeRun,
  getRun as getRunFromDB,
  listMessages,
  listRunFrames,
  requestRunCancellation,
} from '../db'
import type { SessionActions } from '../types'
import {
  releaseRuntimeActivity,
  runtimeActivityKey,
} from '@/runtime/activity'
import { closeRunStream } from '@/runtime/durable-run-stream'

export const cancel: SessionActions['cancel'] = async (context, runId) => {
  const run = await requestRunCancellation(context.db, runId)
  if (!run) return { cancelled: false, runId }

  if (!run.startedAt && context.vars.activeRun?.runId !== runId) {
    const chunk = {
      type: 'abort' as const,
      reason: 'cancelled before execution',
    }
    const finalized = await finalizeRun(context.db, runId, {
      status: 'cancelled',
      sequence: 0,
      chunk,
    })
    try {
      await closeRunStream(runId, chunk)
    } catch (error) {
      context.log.warn({
        msg: 'durable run stream close failed',
        runId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    context.broadcast('frame', { runId, seq: 0, chunk })
    context.broadcast('statusChanged', {
      runId,
      runStatus: 'cancelled',
      status: toChatStatus('cancelled'),
    })
    const messages = await listMessages(context.db)
    context.broadcast('messagesChanged', {
      messages,
      revision: finalized.revision,
    })
    releaseRuntimeActivity(runtimeActivityKey(run.idempotencyId))
    return { cancelled: true, runId }
  }

  context.broadcast('statusChanged', {
    runId,
    runStatus: 'cancel_requested',
    status: toChatStatus('cancel_requested'),
  })
  if (context.vars.activeRun?.runId === runId)
    context.vars.activeRun.abortController.abort()
  return { cancelled: true, runId }
}
export const getRun: SessionActions['getRun'] = (context, runId) =>
  getRunFromDB(context.db, runId)
export const streamSnapshot: SessionActions['streamSnapshot'] = async (
  context,
  runId,
  afterSeq = -1
) => {
  const [run, frames] = await Promise.all([
    getRunFromDB(context.db, runId),
    listRunFrames(context.db, runId, afterSeq),
  ])
  return { run, frames }
}
