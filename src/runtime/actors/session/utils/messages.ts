import { type UIMessage, isToolUIPart } from 'ai'
import type { InboxMessage } from '../config'

export function messageWithOrigin(inboxMessage: InboxMessage): UIMessage {
  const metadata =
    inboxMessage.message.metadata &&
    typeof inboxMessage.message.metadata === 'object'
      ? inboxMessage.message.metadata
      : {}
  return {
    ...inboxMessage.message,
    metadata: { ...metadata, sensosOrigin: inboxMessage.origin },
  }
}

export function isWaitingForHumanInput(messages: UIMessage[]): boolean {
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

export function hasAssistantContent(
  message: UIMessage | undefined
): boolean {
  return message?.parts.some(part => part.type !== 'step-start') ?? false
}

export function cutoffAssistantMessage(
  assistantMessageId: string,
  responseMessage: UIMessage | undefined,
  fallback: '[Interrupted]' | '[Stopped]'
): UIMessage {
  if (hasAssistantContent(responseMessage))
    return responseMessage as UIMessage
  return {
    id: assistantMessageId,
    role: 'assistant',
    parts: [{ type: 'text', text: fallback, state: 'done' }],
  }
}
