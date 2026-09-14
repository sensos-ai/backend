import {
  appendMessageIfAbsent,
  deleteSessionData,
  getRun as getRunFromDB,
  getSessionMeta,
  listMessages,
  listRunFrames,
  listRuns,
  requestRunCancellation,
} from './db'
import { toChatStatus } from './config'
import type { SessionActions } from './types'
import { configuredSessionCatalog } from '@/storage/session-catalog'
import { isToolUIPart, type UIMessage } from 'ai'
import type { DeliveryRoutedEvent } from './config'

function isWaitingForHumanInput(messages: UIMessage[]): boolean {
  const latest = messages.at(-1)
  return (
    latest?.role === 'assistant' &&
    latest.parts.some(
      part =>
        isToolUIPart(part) &&
        part.state === 'approval-requested' &&
        part.approval.isAutomatic !== true
    )
  )
}

const deliver: SessionActions['deliver'] = async (
  context,
  inboxMessage
) => {
  const activeRun = context.vars.activeRun
  const shouldSteer =
    inboxMessage.priority === 'now' ||
    (inboxMessage.priority === 'adaptive' && activeRun !== undefined)

  if (
    inboxMessage.priority === 'now' &&
    !activeRun &&
    isWaitingForHumanInput(await listMessages(context.db))
  ) {
    const receipt = {
      id: inboxMessage.id,
      status: 'refused',
      reason: 'waiting_for_input',
      origin: inboxMessage.origin,
    } satisfies DeliveryRoutedEvent
    context.broadcast('deliveryRouted', receipt)
    return receipt
  }

  await context.queue.send('inbox', inboxMessage)
  if (shouldSteer && activeRun) {
    const message = {
      ...inboxMessage.message,
      metadata: {
        ...(inboxMessage.message.metadata &&
        typeof inboxMessage.message.metadata === 'object'
          ? inboxMessage.message.metadata
          : {}),
        sensosOrigin: inboxMessage.origin,
      },
    }
    const accepted =
      inboxMessage.priority === 'now'
        ? activeRun.interrupt({ message, origin: inboxMessage.origin })
        : activeRun.steering.push({
            message,
            origin: inboxMessage.origin,
          })
    if (!accepted) {
      const receipt = {
        id: inboxMessage.id,
        status: 'queued',
        origin: inboxMessage.origin,
      } satisfies DeliveryRoutedEvent
      context.broadcast('deliveryRouted', receipt)
      return receipt
    }

    if (inboxMessage.priority === 'adaptive') {
      const appended = await appendMessageIfAbsent(
        context.db,
        message,
        new Date(inboxMessage.createdAt)
      )
      context.broadcast('messagesChanged', {
        messages: await listMessages(context.db),
        revision: appended.revision,
      })
    }

    const receipt = {
      id: inboxMessage.id,
      status: 'steered',
      runId: activeRun.runId,
      origin: inboxMessage.origin,
    } satisfies DeliveryRoutedEvent
    context.broadcast('deliveryRouted', receipt)
    return receipt
  }

  {
    const receipt = {
      id: inboxMessage.id,
      status: 'queued',
      origin: inboxMessage.origin,
    } satisfies DeliveryRoutedEvent
    context.broadcast('deliveryRouted', receipt)
    return receipt
  }
}

const cancel: SessionActions['cancel'] = async (context, runId) => {
  const run = await requestRunCancellation(context.db, runId)
  if (!run) {
    return { cancelled: false, runId }
  }
  context.broadcast('statusChanged', {
    runId,
    runStatus: 'cancel_requested',
    status: toChatStatus('cancel_requested'),
  })

  if (context.vars.activeRun?.runId === runId) {
    context.vars.activeRun.abortController.abort()
  }

  return { cancelled: true, runId }
}

const getSession: SessionActions['getSession'] = async context => {
  const [messages, meta, recentRuns] = await Promise.all([
    listMessages(context.db),
    getSessionMeta(context.db),
    listRuns(context.db, 1),
  ])
  const activeRun = meta.activeRunId
    ? await getRunFromDB(context.db, meta.activeRunId)
    : undefined
  const latestRun = activeRun ?? recentRuns[0]
  const runStatus = latestRun?.status ?? 'idle'

  try {
    await configuredSessionCatalog()?.replaceMessages(
      context.state.sessionId,
      meta.revision,
      messages
    )
  } catch (error) {
    context.log.warn({
      msg: 'local transcript reconciliation failed',
      sessionId: context.state.sessionId,
      revision: meta.revision,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  return {
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

const getRun: SessionActions['getRun'] = (context, runId) =>
  getRunFromDB(context.db, runId)

const setModel: SessionActions['setModel'] = (context, model) => {
  context.state.config.model = model
  return { model }
}

const setFeatures: SessionActions['setFeatures'] = (context, features) => {
  context.state.config.features = features
  return { features }
}

const streamSnapshot: SessionActions['streamSnapshot'] = async (
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

// This permanently destroys the actor and its local transcript. Client code
// should use the Rivet connection's own dispose method to merely disconnect.
const deleteSession: SessionActions['deleteSession'] = async context => {
  context.vars.activeRun?.abortController.abort()
  await configuredSessionCatalog()?.tombstone(context.state.sessionId)
  await deleteSessionData(context.db)
  context.destroy()
}

export default {
  cancel,
  deliver,
  deleteSession,
  getRun,
  getSession,
  setFeatures,
  setModel,
  streamSnapshot,
} satisfies SessionActions
