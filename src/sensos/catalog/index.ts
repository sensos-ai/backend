import { Database } from 'bun:sqlite'
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { drizzle, type BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'
import type { UIMessage } from 'ai'
import { catalogMigrations } from './migrations'
import {
  messages,
  schema,
  sessions,
  type SessionCatalogRecord,
} from './schema'

export const SESSION_CATALOG_PATH_ENV = 'SENSOS_SESSION_CATALOG_PATH'

export type CreateSessionCatalogInput = {
  sessionId: string
  cwd?: string
  title?: string
}

export type SessionCatalogPatch = {
  actorId?: string
  cwd?: string
  title?: string
  lastOpenedAt?: number
}

export class CatalogRevisionConflictError extends Error {
  constructor(readonly sessionId: string) {
    super(`Session catalog revision conflict for ${sessionId}`)
  }
}

export interface SessionCatalog {
  reserve(input: CreateSessionCatalogInput): Promise<SessionCatalogRecord>
  get(sessionId: string): Promise<SessionCatalogRecord | undefined>
  list(cwd?: string): Promise<SessionCatalogRecord[]>
  bindActor(
    sessionId: string,
    actorId: string,
    cwd?: string
  ): Promise<SessionCatalogRecord>
  update(
    sessionId: string,
    expectedRevision: number,
    patch: SessionCatalogPatch
  ): Promise<SessionCatalogRecord>
  touch(sessionId: string): Promise<void>
  markOpened(sessionId: string): Promise<void>
  getMessages(sessionId: string): Promise<UIMessage[]>
  replaceMessages(
    sessionId: string,
    transcriptRevision: number,
    nextMessages: UIMessage[]
  ): Promise<boolean>
  tombstone(sessionId: string): Promise<void>
  purge(sessionIds: string[]): Promise<void>
  close(): void
}

class LocalSessionCatalog implements SessionCatalog {
  readonly #native: Database
  readonly #db: BunSQLiteDatabase<typeof schema>

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.#native = new Database(path, { create: true })
    this.#native.exec('PRAGMA journal_mode = WAL')
    this.#native.exec('PRAGMA busy_timeout = 5000')
    this.#native.exec('PRAGMA foreign_keys = ON')
    this.#migrate()
    this.#db = drizzle(this.#native, { schema })
  }

  #migrate(): void {
    this.#native.exec(`
      CREATE TABLE IF NOT EXISTS __catalog_migrations (
        id INTEGER PRIMARY KEY NOT NULL,
        applied_at INTEGER NOT NULL
      )
    `)
    this.#native.exec('BEGIN IMMEDIATE')
    try {
      const applied = this.#native
        .query<{ id: number }, []>('SELECT id FROM __catalog_migrations')
        .all()
      const appliedIds = new Set(applied.map(row => row.id))
      for (const migration of catalogMigrations) {
        if (appliedIds.has(migration.id)) continue
        this.#native.exec(migration.sql)
        this.#native
          .query(
            'INSERT INTO __catalog_migrations (id, applied_at) VALUES (?, ?)'
          )
          .run(migration.id, Date.now())
      }
      this.#native.exec('COMMIT')
    } catch (error) {
      this.#native.exec('ROLLBACK')
      throw error
    }
  }

  async reserve(
    input: CreateSessionCatalogInput
  ): Promise<SessionCatalogRecord> {
    const now = Date.now()
    await this.#db
      .insert(sessions)
      .values({
        sessionId: input.sessionId,
        cwd: input.cwd,
        title: input.title,
        createdAt: now,
        updatedAt: now,
        revision: 1,
      })
      .onConflictDoNothing({ target: sessions.sessionId })
    const session = await this.get(input.sessionId)
    if (!session) throw new Error(`Failed to reserve ${input.sessionId}`)
    if (session.deletedAt) {
      throw new Error(`Session ${input.sessionId} was deleted`)
    }
    return session
  }

  async get(sessionId: string): Promise<SessionCatalogRecord | undefined> {
    const [session] = await this.#db
      .select()
      .from(sessions)
      .where(eq(sessions.sessionId, sessionId))
      .limit(1)
    return session
  }

  list(cwd?: string): Promise<SessionCatalogRecord[]> {
    return this.#db
      .select()
      .from(sessions)
      .where(
        cwd
          ? and(
              isNull(sessions.deletedAt),
              or(eq(sessions.cwd, cwd), isNull(sessions.cwd))
            )
          : isNull(sessions.deletedAt)
      )
      .orderBy(desc(sessions.updatedAt))
  }

  async bindActor(
    sessionId: string,
    actorId: string,
    cwd?: string
  ): Promise<SessionCatalogRecord> {
    const current = await this.requireActive(sessionId)
    if (current.actorId === actorId && (!cwd || current.cwd === cwd)) {
      return current
    }
    return this.update(sessionId, current.revision, { actorId, cwd })
  }

  async update(
    sessionId: string,
    expectedRevision: number,
    patch: SessionCatalogPatch
  ): Promise<SessionCatalogRecord> {
    const [updated] = await this.#db
      .update(sessions)
      .set({
        ...patch,
        updatedAt: Date.now(),
        revision: sql`${sessions.revision} + 1`,
      })
      .where(
        and(
          eq(sessions.sessionId, sessionId),
          eq(sessions.revision, expectedRevision),
          isNull(sessions.deletedAt)
        )
      )
      .returning()
    if (!updated) throw new CatalogRevisionConflictError(sessionId)
    return updated
  }

  async touch(sessionId: string): Promise<void> {
    await this.#db
      .update(sessions)
      .set({ updatedAt: Date.now() })
      .where(
        and(eq(sessions.sessionId, sessionId), isNull(sessions.deletedAt))
      )
  }

  async markOpened(sessionId: string): Promise<void> {
    const now = Date.now()
    await this.#db
      .update(sessions)
      .set({ lastOpenedAt: now, updatedAt: now })
      .where(
        and(eq(sessions.sessionId, sessionId), isNull(sessions.deletedAt))
      )
  }

  async getMessages(sessionId: string): Promise<UIMessage[]> {
    const rows = await this.#db
      .select({ payload: messages.payload })
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(asc(messages.sequence))
    return rows.map(row => row.payload)
  }

  async replaceMessages(
    sessionId: string,
    transcriptRevision: number,
    nextMessages: UIMessage[]
  ): Promise<boolean> {
    return this.#db.transaction(async transaction => {
      const [session] = await transaction
        .select({ transcriptRevision: sessions.transcriptRevision })
        .from(sessions)
        .where(
          and(
            eq(sessions.sessionId, sessionId),
            isNull(sessions.deletedAt)
          )
        )
        .limit(1)
      if (!session || transcriptRevision < session.transcriptRevision) {
        return false
      }

      await transaction
        .delete(messages)
        .where(eq(messages.sessionId, sessionId))
      if (nextMessages.length > 0) {
        await transaction.insert(messages).values(
          nextMessages.map((message, sequence) => ({
            sessionId,
            id: message.id,
            sequence,
            role: message.role,
            payload: message,
          }))
        )
      }
      await transaction
        .update(sessions)
        .set({ transcriptRevision, updatedAt: Date.now() })
        .where(eq(sessions.sessionId, sessionId))
      return true
    })
  }

  async tombstone(sessionId: string): Promise<void> {
    const now = Date.now()
    await this.#db
      .update(sessions)
      .set({
        deletedAt: now,
        updatedAt: now,
        revision: sql`${sessions.revision} + 1`,
      })
      .where(
        and(eq(sessions.sessionId, sessionId), isNull(sessions.deletedAt))
      )
  }

  async purge(sessionIds: string[]): Promise<void> {
    if (sessionIds.length === 0) return
    await this.#db
      .delete(sessions)
      .where(inArray(sessions.sessionId, sessionIds))
  }

  close(): void {
    this.#native.close(false)
  }

  private async requireActive(
    sessionId: string
  ): Promise<SessionCatalogRecord> {
    const session = await this.get(sessionId)
    if (!session || session.deletedAt) {
      throw new Error(`Session ${sessionId} does not exist`)
    }
    return session
  }
}

const catalogs = new Map<string, LocalSessionCatalog>()

export function openSessionCatalog(path: string): SessionCatalog {
  const existing = catalogs.get(path)
  if (existing) return existing
  const catalog = new LocalSessionCatalog(path)
  catalogs.set(path, catalog)
  return catalog
}

export function configuredSessionCatalog(): SessionCatalog | undefined {
  const path = process.env[SESSION_CATALOG_PATH_ENV]
  return path ? openSessionCatalog(path) : undefined
}

export async function updateCatalogTitle(
  catalog: SessionCatalog,
  sessionId: string,
  expectedRevision: number,
  title: string
): Promise<SessionCatalogRecord> {
  try {
    return await catalog.update(sessionId, expectedRevision, { title })
  } catch (error) {
    if (!(error instanceof CatalogRevisionConflictError)) throw error
    const current = await catalog.get(sessionId)
    if (!current || current.deletedAt) {
      throw new Error(`Session ${sessionId} was deleted`)
    }
    if (current.title) return current
    return catalog.update(sessionId, current.revision, { title })
  }
}
