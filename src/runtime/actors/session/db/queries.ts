import type {
  FinishReason,
  GatewayModelId,
  LanguageModelUsage,
  UIMessage,
  UIMessageChunk,
} from 'ai'
import { and, asc, desc, eq, gt, max, notInArray } from 'drizzle-orm'
import type { SessionDatabase } from './database'
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

async function nextMessageSequence(database: SessionDatabase) {
  const [row] = await database
    .select({ sequence: max(messages.sequence) })
    .from(messages)
  return (row?.sequence ?? -1) + 1
}

export async function ensureSessionMeta(database: SessionDatabase) {
  await database
    .insert(sessionMeta)
    .values({ singletonId: SESSION_META_ID, revision: 0 })
    .onConflictDoNothing({ target: sessionMeta.singletonId })
}

export async function setSessionTitle(
  database: SessionDatabase,
  title: string
): Promise<void> {
  await database
    .insert(sessionMeta)
    .values({ singletonId: SESSION_META_ID, revision: 0, title })
    .onConflictDoUpdate({
      target: sessionMeta.singletonId,
      set: { title },
    })
}

export async function getSessionMeta(database: SessionDatabase) {
  const [meta] = await database
    .select()
    .from(sessionMeta)
    .where(eq(sessionMeta.singletonId, SESSION_META_ID))
    .limit(1)
  return (
    meta ?? {
      singletonId: SESSION_META_ID,
      revision: 0,
      activeRunId: null,
      title: null,
    }
  )
}

export async function listMessages(
  database: SessionDatabase
): Promise<UIMessage[]> {
  const rows = await database
    .select({ payload: messages.payload })
    .from(messages)
    .orderBy(asc(messages.sequence))
  return rows.map(row => row.payload)
}

export async function messageExists(
  database: SessionDatabase,
  messageId: string
): Promise<boolean> {
  const [message] = await database
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1)
  return message !== undefined
}

export async function appendMessage(
  database: SessionDatabase,
  message: UIMessage,
  createdAt = new Date()
): Promise<number> {
  return database.transaction(
    async transaction => {
      const sequence = await nextMessageSequence(transaction)
      await transaction.insert(messages).values({
        id: message.id,
        sequence,
        role: message.role,
        payload: message,
        createdAt,
      })
      const meta = await getSessionMeta(transaction)
      const revision = meta.revision + 1
      await transaction
        .insert(sessionMeta)
        .values({ singletonId: SESSION_META_ID, revision })
        .onConflictDoUpdate({
          target: sessionMeta.singletonId,
          set: { revision },
        })
      return revision
    },
    { name: 'append-session-message' }
  )
}

export async function appendMessageIfAbsent(
  database: SessionDatabase,
  message: UIMessage,
  createdAt = new Date()
): Promise<{ created: boolean; revision: number }> {
  return database.transaction(
    async transaction => {
      const [existing] = await transaction
        .select({ id: messages.id })
        .from(messages)
        .where(eq(messages.id, message.id))
        .limit(1)
      const meta = await getSessionMeta(transaction)
      if (existing) return { created: false, revision: meta.revision }

      const sequence = await nextMessageSequence(transaction)
      await transaction.insert(messages).values({
        id: message.id,
        sequence,
        role: message.role,
        payload: message,
        createdAt,
      })
      const revision = meta.revision + 1
      await transaction
        .insert(sessionMeta)
        .values({ singletonId: SESSION_META_ID, revision })
        .onConflictDoUpdate({
          target: sessionMeta.singletonId,
          set: { revision },
        })
      return { created: true, revision }
    },
    { name: 'append-session-message-if-absent' }
  )
}

export async function replaceMessages(
  database: SessionDatabase,
  nextMessages: UIMessage[],
  createdAt = new Date()
): Promise<number> {
  return database.transaction(
    async transaction => {
      await transaction.delete(messages)
      if (nextMessages.length > 0) {
        await transaction.insert(messages).values(
          nextMessages.map((message, sequence) => ({
            id: message.id,
            sequence,
            role: message.role,
            payload: message,
            createdAt,
          }))
        )
      }
      const meta = await getSessionMeta(transaction)
      const revision = meta.revision + 1
      await transaction
        .insert(sessionMeta)
        .values({ singletonId: SESSION_META_ID, revision })
        .onConflictDoUpdate({
          target: sessionMeta.singletonId,
          set: { revision },
        })
      return revision
    },
    { name: 'replace-session-messages' }
  )
}

export async function deleteSessionData(
  database: SessionDatabase
): Promise<void> {
  await database.transaction(
    async transaction => {
      await transaction.delete(runFrames)
      await transaction.delete(runs)
      await transaction.delete(messages)
      await transaction.delete(sessionMeta)
    },
    { name: 'delete-session-data' }
  )
}

export interface SubmitRunInput {
  runId: string
  idempotencyId: string
  model?: GatewayModelId
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
          ...(input.model ? { model: input.model } : {}),
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

export async function appendRunFrame(
  database: SessionDatabase,
  runId: string,
  sequence: number,
  payload: UIMessageChunk,
  createdAt = new Date()
) {
  await database
    .insert(runFrames)
    .values({ runId, sequence, payload, createdAt })
}

export async function listRunFrames(
  database: SessionDatabase,
  runId: string,
  afterSequence = -1
) {
  return database
    .select({ seq: runFrames.sequence, chunk: runFrames.payload })
    .from(runFrames)
    .where(
      and(
        eq(runFrames.runId, runId),
        gt(runFrames.sequence, afterSequence)
      )
    )
    .orderBy(asc(runFrames.sequence))
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
