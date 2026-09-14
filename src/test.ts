import type { UIMessage } from 'ai'
import { createClient } from 'rivetkit/client'
import type { registry } from './runtime/actors/registry'
import { createIdGeneratorWithPrefix } from '@/shared/utils'
import type { SessionConnection } from '@/chat/transport/session-chat-transport'

const client = createClient<typeof registry>('http://localhost:6420')
const createClientId = createIdGeneratorWithPrefix('cli')
const createMessageId = createIdGeneratorWithPrefix('msg')
const createIdempotencyId = createIdGeneratorWithPrefix('request')
const clientId = createClientId()
const handle = client.session.getOrCreate(['test-1'], {
  createWithInput: {
    cwd: process.cwd(),
    initialMessages: [],
  },
  params: { clientId },
})
const connection = handle.connect() as SessionConnection

connection.on('frame', frame => {
  console.log(`[${frame.runId}:${frame.seq}]`, frame.chunk)
})

connection.on('statusChanged', status => {
  console.log(`[${status.runId ?? 'session'}] ${status.status}`)
})

connection.on('messagesChanged', event => {
  console.log(`messages: ${event.messages.length}`)
})

const message: UIMessage = {
  id: createMessageId(),
  role: 'user',
  parts: [{ type: 'text', text: 'Hello, world!' }],
}

const queued = await connection.send(
  'runs',
  {
    idempotencyId: createIdempotencyId(),
    model: {
      provider: 'gateway',
      modelId: 'openai/gpt-5.6-terra',
    },
    message,
  },
  { wait: true, timeout: 10_000 }
)
if (queued.status !== 'completed' || !queued.response) {
  throw new Error('Timed out waiting for run submission')
}
const result = queued.response

console.log(result)
