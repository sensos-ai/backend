import type {
  FinishReason,
  LanguageModelUsage,
  UIMessage,
  UIMessageChunk,
} from 'ai'
import type { ModelRef } from '@/chat/harness/providers/model'
import { and, desc, eq, notInArray } from 'drizzle-orm'
import type { SessionDatabase } from './database'
import { messageExists, nextMessageSequence } from './messages'
import { getSessionMeta } from './session-meta'
import {
  messages,
  runFrames,
  runs,
  SESSION_META_ID,
  sessionMeta,
  type RunRow,
  type RunResponseMetadata,
  type RunStatus,
  type RunStepMetadata,
} from './schema'

const terminalStatuses = new Set<RunStatus>([
  'cancelled',
  'completed',
  'failed',
  'interrupted',
])

export interface SubmitRunInput {
  runId: string
  idempotencyId: string
  model?: ModelRef
  message: UIMessage
  assistantMessageId: string
  createdAt?: Date
}

export type SubmitRunResult =
  | { accepted: true; created: boolean; run: RunRow; revision: number }
  | { accepted: false; created: false; run: RunRow; revision: number }

export async function submitRun(
  database: SessionDatabase,
  input: SubmitRunInput
): Promise<SubmitRunResult> {
  return database.transaction(
    async transaction => {
      const existing = await getRunByIdempotencyId(
        transaction,
        input.idempotencyId
      )
      const meta = await getSessionMeta(transaction)

      if (existing) {
        return {
          accepted: true,
          created: false,
          run: existing,
          revision: meta.revision,
        }
      }

      if (meta.activeRunId) {
        const activeRun = await getRun(transaction, meta.activeRunId)
        if (activeRun && !terminalStatuses.has(activeRun.status)) {
          return {
            accepted: false,
            created: false,
            run: activeRun,
            revision: meta.revision,
          }
        }
      }

      const createdAt = input.createdAt ?? new Date()
      const messageAlreadyExists = await messageExists(
        transaction,
        input.message.id
      )
      if (!messageAlreadyExists) {
        const sequence = await nextMessageSequence(transaction)
        await transaction.insert(messages).values({
          id: input.message.id,
          sequence,
          role: input.message.role,
          payload: input.message,
          createdAt,
        })
      }
      const [run] = await transaction
        .insert(runs)
        .values({
          id: input.runId,
          idempotencyId: input.idempotencyId,
          ...(input.model
            ? {
                modelProvider: input.model.provider,
                modelId: input.model.modelId,
              }
            : {}),
          userMessageId: input.message.id,
          assistantMessageId: input.assistantMessageId,
          status: 'queued',
          createdAt,
        })
        .returning()
      if (!run) throw new Error(`Failed to create run ${input.runId}`)

      const revision = meta.revision + (messageAlreadyExists ? 0 : 1)
      await transaction
        .insert(sessionMeta)
        .values({
          singletonId: SESSION_META_ID,
          revision,
          activeRunId: run.id,
        })
        .onConflictDoUpdate({
          target: sessionMeta.singletonId,
          set: { revision, activeRunId: run.id },
        })
      return { accepted: true, created: true, run, revision }
    },
    { name: 'submit-session-run' }
  )
}

export interface UpdateRunInput {
  status: RunStatus
  error?: string | null
  finishReason?: FinishReason | null
  startedAt?: Date | null
  finishedAt?: Date | null
}

export async function updateRun(
  database: SessionDatabase,
  runId: string,
  input: UpdateRunInput
): Promise<RunRow | undefined> {
  const [run] = await database
    .update(runs)
    .set({
      status: input.status,
      ...(input.error !== undefined ? { error: input.error } : {}),
      ...(input.finishReason !== undefined
        ? { finishReason: input.finishReason }
        : {}),
      ...(input.startedAt !== undefined
        ? { startedAt: input.startedAt }
        : {}),
      ...(input.finishedAt !== undefined
        ? { finishedAt: input.finishedAt }
        : {}),
    })
    .where(eq(runs.id, runId))
    .returning()
  return run
}

export async function requestRunCancellation(
  database: SessionDatabase,
  runId: string
): Promise<RunRow | undefined> {
  const [run] = await database
    .update(runs)
    .set({ status: 'cancel_requested' })
    .where(
      and(
        eq(runs.id, runId),
        notInArray(runs.status, [...terminalStatuses])
      )
    )
    .returning()
  return run
}

export interface FinalizeRunInput {
  status: Extract<
    RunStatus,
    'cancelled' | 'completed' | 'failed' | 'interrupted'
  >
  sequence: number
  chunk: UIMessageChunk
  responseMessage?: UIMessage
  error?: string | null
  finishReason?: FinishReason
  steps?: RunStepMetadata[]
  totalUsage?: LanguageModelUsage
  responseMetadata?: RunResponseMetadata
  finishedAt?: Date
}

export async function finalizeRun(
  database: SessionDatabase,
  runId: string,
  input: FinalizeRunInput
): Promise<{ run: RunRow; revision: number }> {
  return database.transaction(
    async transaction => {
      const meta = await getSessionMeta(transaction)
      let revision = meta.revision
      if (input.responseMessage) {
        const sequence = await nextMessageSequence(transaction)
        await transaction.insert(messages).values({
          id: input.responseMessage.id,
          sequence,
          role: input.responseMessage.role,
          payload: input.responseMessage,
          createdAt: input.finishedAt ?? new Date(),
        })
        revision += 1
      }

      await transaction.insert(runFrames).values({
        runId,
        sequence: input.sequence,
        payload: input.chunk,
        createdAt: input.finishedAt ?? new Date(),
      })
      const [run] = await transaction
        .update(runs)
        .set({
          status: input.status,
          error: input.error ?? null,
          finishReason: input.finishReason ?? null,
          steps: input.steps ?? null,
          totalUsage: input.totalUsage ?? null,
          responseMetadata: input.responseMetadata ?? null,
          finishedAt: input.finishedAt ?? new Date(),
        })
        .where(eq(runs.id, runId))
        .returning()
      if (!run) throw new Error(`Run ${runId} does not exist`)

      await transaction
        .insert(sessionMeta)
        .values({
          singletonId: SESSION_META_ID,
          revision,
          activeRunId: null,
        })
        .onConflictDoUpdate({
          target: sessionMeta.singletonId,
          set: { revision, activeRunId: null },
        })
      return { run, revision }
    },
    { name: 'finalize-session-run' }
  )
}

export async function getRun(database: SessionDatabase, runId: string) {
  const [run] = await database
    .select()
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1)
  return run
}

export async function getRunByIdempotencyId(
  database: SessionDatabase,
  idempotencyId: string
) {
  const [run] = await database
    .select()
    .from(runs)
    .where(eq(runs.idempotencyId, idempotencyId))
    .limit(1)
  return run
}

export async function listRuns(database: SessionDatabase, limit = 50) {
  return database
    .select()
    .from(runs)
    .orderBy(desc(runs.createdAt))
    .limit(limit)
}
