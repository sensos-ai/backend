import type { ChatStatus, UIMessage, UIMessageChunk } from 'ai'
import { z } from 'zod'
import { protocolVersionSchema } from '@sensos-ai/protocol/core'
import { modelRefSchema, type ModelRef } from '@sensos-ai/protocol/models'

export const runStatusSchema = z.enum([
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
])

export type RunStatus = z.infer<typeof runStatusSchema>
export type SessionStatus = 'idle' | RunStatus

export const sessionInputSchema = z.object({
  protocolVersion: protocolVersionSchema,
  sessionId: z.string().min(1),
  catalogRevision: z.number().int().nonnegative().optional(),
  cwd: z.string().min(1),
  model: modelRefSchema.optional(),
  instructions: z.string().optional(),
  initialMessages: z.array(z.custom<UIMessage>()).optional(),
})

export type SessionInput = z.input<typeof sessionInputSchema>

export type RunCommand = {
  idempotencyId: string
  model?: ModelRef
  message: UIMessage
}

export type InboxMessage = {
  id: string
  priority: 'now' | 'next' | 'adaptive'
  message: UIMessage
  createdAt: number
  origin:
    | { type: 'client'; clientId: string }
    | { type: 'session'; sessionId: string }
    | { type: 'system' }
}

export type RunCompletion = {
  accepted: boolean
  deduplicated: boolean
  runId: string
  status: RunStatus
  reason?: 'session_busy'
}

export type SessionSnapshot = {
  messages: UIMessage[]
  revision: number
  runStatus: SessionStatus
  status: ChatStatus
  activeRunId?: string
  model?: ModelRef
  title?: string
  error?: string
}

export type SessionActions = {
  cancel: {
    input: { runId: string }
    output: { cancelled: boolean; runId: string }
  }
  deliver: { input: InboxMessage; output: DeliveryRoutedEvent }
  deleteSession: { input: undefined; output: undefined }
  getSession: { input: undefined; output: SessionSnapshot }
  setModel: { input: ModelRef; output: undefined }
  getRun: { input: { runId: string }; output: unknown }
  streamSnapshot: {
    input: { runId: string; afterSeq?: number }
    output: FrameEvent[]
  }
}

export type FrameEvent = {
  runId: string
  seq: number
  chunk: UIMessageChunk
}

export type StatusChangedEvent = {
  runId?: string
  runStatus: SessionStatus
  status: ChatStatus
  error?: string
}

export type DeliveryRoutedEvent = {
  id: string
  status: 'queued' | 'started' | 'steered' | 'refused'
  runId?: string
  reason?: 'waiting_for_input' | 'session_busy' | 'not_active'
  origin: InboxMessage['origin']
}

export type SessionEvents = {
  frame: FrameEvent
  statusChanged: StatusChangedEvent
  messagesChanged: { messages: UIMessage[]; revision: number }
  titleChanged: { title: string }
  deliveryRouted: DeliveryRoutedEvent
}
