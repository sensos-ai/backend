import type { UIMessage } from 'ai'
import { configuredSessionCatalog } from '@/storage/session-catalog'
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

export async function processInbox(
  context: SessionWorkflowContext,
  queueStepName: 'next-inbox' | 'next-active-inbox' = 'next-inbox'
): Promise<{ kind: 'inbox' }> {
  const queued = await context.queue.next(queueStepName, {
    names: ['inbox'],
  })
  const inboxMessage = queued.body

  await context.step('route-inbox', async step => {
    if (await messageExists(step.db, inboxMessage.message.id)) return
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
        await projectTranscript(
          step.state.sessionId,
          appended.revision,
          messages,
          step.log
        )
        step.broadcast('messagesChanged', {
          messages,
          revision: appended.revision,
        })
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
