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
}

export const events = {
  frame: event<FrameEvent>(),
  statusChanged: event<StatusChangedEvent>(),
  messagesChanged: event<{ messages: UIMessage[]; revision: number }>(),
  titleChanged: event<{ title: string }>(),
}

export type SessionQueues = typeof queues
export type SessionEvents = typeof events
