import { toChatStatus } from '../config'
import {
  getRun as getRunFromDB,
  listRunFrames,
  requestRunCancellation,
} from '../db'
import type { SessionActions } from '../types'

export const cancel: SessionActions['cancel'] = async (context, runId) => {
  const run = await requestRunCancellation(context.db, runId)
  if (!run) return { cancelled: false, runId }
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
