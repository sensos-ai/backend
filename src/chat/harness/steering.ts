import {
  convertToModelMessages,
  type ModelMessage,
  type UIMessage,
} from 'ai'

export type MessageOrigin =
  | { type: 'client'; clientId: string }
  | { type: 'session'; sessionId: string }
  | { type: 'system' }

export type SteeringMessage = {
  message: UIMessage
  origin: MessageOrigin
}

export type HarnessSteeringInput = {
  drain(): SteeringMessage[] | Promise<SteeringMessage[]>
}

function originLabel(origin: MessageOrigin): string {
  switch (origin.type) {
    case 'client':
      return `Client ${origin.clientId}`
    case 'session':
      return `Session ${origin.sessionId}`
    case 'system':
      return 'System'
  }
}

export function withOriginAttribution({
  message,
  origin,
}: SteeringMessage): UIMessage {
  const label = originLabel(origin)
  return {
    ...message,
    parts: message.parts.map((part, index) =>
      index === 0 && part.type === 'text'
        ? { ...part, text: `[${label}]\n${part.text}` }
        : part
    ),
  }
}

export async function appendSteeringMessages(
  messages: ModelMessage[],
  steeringInput: HarnessSteeringInput
): Promise<ModelMessage[] | undefined> {
  const steeringMessages = await steeringInput.drain()
  if (steeringMessages.length === 0) return undefined

  const modelMessages = await convertToModelMessages(
    steeringMessages.map(withOriginAttribution)
  )
  return [...messages, ...modelMessages]
}

export function createRunSteeringInput(): HarnessSteeringInput & {
  push(message: SteeringMessage): boolean
  close(): SteeringMessage[]
} {
  const pending: SteeringMessage[] = []
  let open = true

  return {
    push(message) {
      if (!open) return false
      pending.push(message)
      return true
    },
    drain() {
      return pending.splice(0, pending.length)
    },
    close() {
      open = false
      return pending.splice(0, pending.length)
    },
  }
}
