import type {
  FinishReason,
  LanguageModelUsage,
  ProviderMetadata,
  UIMessage,
  UIMessageChunk,
} from 'ai'
import type { ModelProvider } from '@/auth/profile'
import type { ModelRef } from '@/chat/harness/providers/model'
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'rivetkit/db/drizzle'

export const runStatuses = [
  'queued',
  'running',
  'cancel_requested',
  'cancelled',
  'completed',
  'failed',
  'interrupted',
] as const

export type RunStatus = (typeof runStatuses)[number]

export const SESSION_META_ID = 1

export type RunResponseMetadata = {
  id: string
  timestamp: string
  modelId: string
}

export type RunStepMetadata = {
  callId: string
  stepNumber: number
  finishReason: FinishReason
  rawFinishReason?: string
  usage: LanguageModelUsage
  providerMetadata?: ProviderMetadata
  response: RunResponseMetadata
}

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    sequence: integer('sequence').notNull(),
    role: text('role').$type<UIMessage['role']>().notNull(),
    payload: text('payload', { mode: 'json' })
      .$type<UIMessage>()
      .notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  table => [uniqueIndex('messages_sequence_unique').on(table.sequence)]
)

export const runs = sqliteTable(
  'runs',
  {
    id: text('id').primaryKey(),
    idempotencyId: text('idempotency_id').notNull(),
    modelProvider: text('model_provider')
      .$type<ModelProvider>()
      .notNull()
      .default('gateway'),
    modelId: text('model')
      .$type<ModelRef['modelId']>()
      .notNull()
      .default('openai/gpt-5.6-terra'),
    steps: text('steps', { mode: 'json' }).$type<RunStepMetadata[]>(),
    totalUsage: text('total_usage', {
      mode: 'json',
    }).$type<LanguageModelUsage>(),
    responseMetadata: text('response_metadata', {
      mode: 'json',
    }).$type<RunResponseMetadata>(),
    userMessageId: text('user_message_id').notNull().default(''),
    assistantMessageId: text('assistant_message_id').notNull().default(''),
    status: text('status').$type<RunStatus>().notNull(),
    finishReason: text('finish_reason').$type<FinishReason>(),
    error: text('error'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }),
    finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
  },
  table => [
    uniqueIndex('runs_idempotency_id_unique').on(table.idempotencyId),
    index('runs_created_at_idx').on(table.createdAt),
  ]
)

export const sessionMeta = sqliteTable('session_meta', {
  singletonId: integer('singleton_id').primaryKey(),
  revision: integer('revision').notNull(),
  activeRunId: text('active_run_id'),
  title: text('title'),
})

export const runFrames = sqliteTable(
  'run_frames',
  {
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    sequence: integer('sequence').notNull(),
    payload: text('payload', { mode: 'json' })
      .$type<UIMessageChunk>()
      .notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  table => [
    primaryKey({ columns: [table.runId, table.sequence] }),
    index('run_frames_run_id_sequence_idx').on(
      table.runId,
      table.sequence
    ),
  ]
)

export const schema = { messages, runs, sessionMeta, runFrames }

export type MessageRow = typeof messages.$inferSelect
export type NewMessageRow = typeof messages.$inferInsert
export type RunRow = typeof runs.$inferSelect
export type NewRunRow = typeof runs.$inferInsert
export type SessionMetaRow = typeof sessionMeta.$inferSelect
export type RunFrameRow = typeof runFrames.$inferSelect
