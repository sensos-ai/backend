import { toChatStatus } from '../config'
import {
  deleteSessionData,
  getRun,
  getSessionMeta,
  listMessages,
  listRuns,
} from '../db'
import type { SessionActions } from '../types'
import { LATEST_SENSOS_PROTOCOL_VERSION } from '@sensos-ai/shared'

export const getSession: SessionActions['getSession'] = async context => {
  const [messages, meta, recentRuns] = await Promise.all([
    listMessages(context.db),
    getSessionMeta(context.db),
    listRuns(context.db, 1),
  ])
  const activeRun = meta.activeRunId
    ? await getRun(context.db, meta.activeRunId)
    : undefined
  const latestRun = activeRun ?? recentRuns[0]
  const runStatus = latestRun?.status ?? 'idle'
  return {
    protocolVersion:
      context.state.protocolVersion ?? LATEST_SENSOS_PROTOCOL_VERSION,
    messages,
    revision: meta.revision,
    runStatus,
    status: toChatStatus(runStatus),
    activeRunId: meta.activeRunId ?? undefined,
    model: context.state.config.model,
    features: context.state.config.features,
    title: meta.title ?? context.state.title,
    error: latestRun?.error ?? undefined,
  }
}
export const setModel: SessionActions['setModel'] = (context, model) => {
  context.state.config.model = model
  return { model }
}
export const setFeatures: SessionActions['setFeatures'] = (
  context,
  features
) => {
  context.state.config.features = features
  return { features }
}
export const deleteSession: SessionActions['deleteSession'] =
  async context => {
    context.vars.activeRun?.abortController.abort()
    await deleteSessionData(context.db)
    context.destroy()
  }
