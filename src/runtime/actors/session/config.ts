import { event, type queue } from 'rivetkit'
import type {
  ChatStatus,
  GatewayModelId,
  UIMessage,
  UIMessageChunk,
} from 'ai'
import { createQueue } from './queue'
import type { RunStatus } from './db'
import { toChatStatus } from './utils/status'
import { z } from 'zod'
import type { MessageOrigin } from '@/chat/harness'

export type QueueTypeToken<
  TMessage,
  TComplete = never,
  TContext = any,
> = ReturnType<typeof queue<TMessage, TComplete, TContext>>

const runCommandSchema = z.object({
  idempotencyId: z.string(),
  model: z
    .custom<GatewayModelId>(value => typeof value === 'string')
    .optional(),
  message: z.custom<UIMessage>(),
})

export type RunCommand = z.input<typeof runCommandSchema>

const inboxMessageSchema = z.object({
  id: z.string(),
  priority: z.enum(['now', 'next', 'adaptive']),
  message: z.custom<UIMessage>(),
  createdAt: z.number(),
  origin: z.discriminatedUnion('type', [
    z.object({ type: z.literal('client'), clientId: z.string() }),
    z.object({ type: z.literal('session'), sessionId: z.string() }),
    z.object({ type: z.literal('system') }),
  ]),
})

export type InboxMessage = z.input<typeof inboxMessageSchema>

export type DeliveryRoutedEvent = {
  id: string
  status: 'queued' | 'started' | 'steered' | 'refused'
  runId?: string
  reason?: 'waiting_for_input' | 'session_busy' | 'not_active'
  origin: MessageOrigin
}

const runCompletionSchema = z.object({
  accepted: z.boolean(),
  deduplicated: z.boolean(),
  runId: z.string(),
  status: z.custom<RunStatus>(value => typeof value === 'string'),
  reason: z.literal('session_busy').optional(),
})

export type RunCompletion = z.output<typeof runCompletionSchema>

export type FrameEvent = {
  runId: string
  seq: number
  chunk: UIMessageChunk
}

export type SessionStatus = 'idle' | RunStatus

export { toChatStatus }

export type StatusChangedEvent = {
  runId?: string
  runStatus: SessionStatus
  status: ChatStatus
  error?: string
}

export const queues = {
  runs: createQueue(runCommandSchema, runCompletionSchema),
  inbox: createQueue(inboxMessageSchema),
}

export const events = {
  frame: event<FrameEvent>(),
  statusChanged: event<StatusChangedEvent>(),
  messagesChanged: event<{ messages: UIMessage[]; revision: number }>(),
  titleChanged: event<{ title: string }>(),
  deliveryRouted: event<DeliveryRoutedEvent>(),
}

export type SessionQueues = typeof queues
export type SessionEvents = typeof events
