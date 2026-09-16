import type { InboxMessage, RunCommand } from '../../config'
import {
  appendMessageIfAbsent,
  listMessages,
  messageExists,
} from '../../db'
import {
  isWaitingForHumanInput,
  messageWithOrigin,
} from '../../utils/messages'
import type { SessionWorkflowContext } from '../types'
import {
  releaseRuntimeActivity,
  runtimeActivityKey,
} from '@/runtime/activity'

export type InboxRouteDecision =
  | { kind: 'queue' }
  | { kind: 'steer'; mode: 'interrupt' | 'adaptive' }
  | { kind: 'refuse'; reason: 'waiting_for_input' }

export function decideInboxRoute(input: {
  priority: InboxMessage['priority']
  hasActiveRun: boolean
  waitingForHumanInput: boolean
}): InboxRouteDecision {
  if (input.priority === 'now' && input.hasActiveRun)
    return { kind: 'steer', mode: 'interrupt' }
  if (input.priority === 'adaptive' && input.hasActiveRun)
    return { kind: 'steer', mode: 'adaptive' }
  if (input.priority === 'now' && input.waitingForHumanInput)
    return { kind: 'refuse', reason: 'waiting_for_input' }
  return { kind: 'queue' }
}

function toRunCommand(
  model: RunCommand['model'],
  inboxMessage: InboxMessage
): RunCommand {
  return {
    idempotencyId: inboxMessage.id,
    model,
    message: messageWithOrigin(inboxMessage),
  }
}

export async function processInbox(
  context: SessionWorkflowContext,
  queueStepName: 'next-inbox' | 'next-active-inbox' = 'next-inbox'
): Promise<{ kind: 'inbox' }> {
  const queued = await context.queue.next(queueStepName, {
    names: ['inbox'],
  })
  const inboxMessage = queued.body
  const activityKey = runtimeActivityKey(inboxMessage.id)

  await context.step('route-inbox', async step => {
    if (await messageExists(step.db, inboxMessage.message.id)) {
      releaseRuntimeActivity(activityKey)
      return
    }
    const activeRun = step.vars.activeRun
    const waitingForHumanInput =
      inboxMessage.priority === 'now' && !activeRun
        ? isWaitingForHumanInput(await listMessages(step.db))
        : false
    const decision = decideInboxRoute({
      priority: inboxMessage.priority,
      hasActiveRun: activeRun !== undefined,
      waitingForHumanInput,
    })

    if (decision.kind === 'refuse') {
      step.broadcast('deliveryRouted', {
        id: inboxMessage.id,
        status: 'refused',
        reason: decision.reason,
        origin: inboxMessage.origin,
      })
      releaseRuntimeActivity(activityKey)
      return
    }

    if (decision.kind === 'steer' && activeRun) {
      const message = messageWithOrigin(inboxMessage)
      const steeringMessage = { message, origin: inboxMessage.origin }
      const accepted =
        decision.mode === 'interrupt'
          ? activeRun.interrupt(steeringMessage)
          : activeRun.steering.push(steeringMessage)
      if (!accepted) {
        await step.queue.send(
          'runs',
          toRunCommand(step.state.config.model, inboxMessage)
        )
        step.broadcast('deliveryRouted', {
          id: inboxMessage.id,
          status: 'queued',
          origin: inboxMessage.origin,
        })
        return
      }

      if (decision.mode === 'adaptive') {
        const appended = await appendMessageIfAbsent(
          step.db,
          message,
          new Date(inboxMessage.createdAt)
        )
        const messages = await listMessages(step.db)
        step.broadcast('messagesChanged', {
          messages,
          revision: appended.revision,
        })
        releaseRuntimeActivity(activityKey)
      }
      step.broadcast('deliveryRouted', {
        id: inboxMessage.id,
        status: 'steered',
        runId: activeRun.runId,
        origin: inboxMessage.origin,
      })
      return
    }

    await step.queue.send(
      'runs',
      toRunCommand(step.state.config.model, inboxMessage)
    )
    step.broadcast('deliveryRouted', {
      id: inboxMessage.id,
      status: 'queued',
      origin: inboxMessage.origin,
    })
  })

  return { kind: 'inbox' }
}
