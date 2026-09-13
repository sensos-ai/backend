import {
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'
import type { UIMessage } from 'ai'

export const sessions = sqliteTable('sessions', {
  sessionId: text('session_id').primaryKey(),
  actorId: text('actor_id').unique(),
  cwd: text('cwd'),
  title: text('title'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  lastOpenedAt: integer('last_opened_at'),
  deletedAt: integer('deleted_at'),
  revision: integer('revision').notNull().default(1),
  transcriptRevision: integer('transcript_revision').notNull().default(0),
})

export const messages = sqliteTable(
  'messages',
  {
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.sessionId, { onDelete: 'cascade' }),
    id: text('id').notNull(),
    sequence: integer('sequence').notNull(),
    role: text('role').notNull(),
    payload: text('payload', { mode: 'json' })
      .$type<UIMessage>()
      .notNull(),
  },
  table => [
    primaryKey({ columns: [table.sessionId, table.id] }),
    uniqueIndex('messages_session_sequence_unique').on(
      table.sessionId,
      table.sequence
    ),
  ]
)

export const schema = { sessions, messages }

export type SessionCatalogRecord = typeof sessions.$inferSelect
