import type { UIMessage } from 'ai'
import { asc, eq, max } from 'drizzle-orm'
import type { SessionDatabase } from './database'
import { messages, SESSION_META_ID, sessionMeta } from './schema'
import { getSessionMeta } from './session-meta'

export async function nextMessageSequence(database: SessionDatabase) {
  const [row] = await database
    .select({ sequence: max(messages.sequence) })
    .from(messages)
  return (row?.sequence ?? -1) + 1
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
