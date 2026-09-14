import type { DeliveryRoutedEvent } from '../config'
import { appendMessageIfAbsent, listMessages } from '../db'
import type { SessionActions } from '../types'
import {
  isWaitingForHumanInput,
  messageWithOrigin,
} from '../utils/messages'
import {
  releaseRuntimeActivity,
  retainRuntimeActivity,
  runtimeActivityKey,
} from '@/runtime/activity'

export const deliver: SessionActions['deliver'] = async (
  context,
  inboxMessage
) => {
  const activityKey = runtimeActivityKey(inboxMessage.id)
  retainRuntimeActivity(activityKey)
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
    releaseRuntimeActivity(activityKey)
    return receipt
  }
  await context.queue.send('inbox', inboxMessage)
  if (shouldSteer && activeRun) {
    const message = messageWithOrigin(inboxMessage)
    const accepted =
      inboxMessage.priority === 'now'
        ? activeRun.interrupt({ message, origin: inboxMessage.origin })
        : activeRun.steering.push({ message, origin: inboxMessage.origin })
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
      releaseRuntimeActivity(activityKey)
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
  const receipt = {
    id: inboxMessage.id,
    status: 'queued',
    origin: inboxMessage.origin,
  } satisfies DeliveryRoutedEvent
  context.broadcast('deliveryRouted', receipt)
  return receipt
}
