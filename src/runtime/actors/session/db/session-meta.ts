import { eq } from 'drizzle-orm'
import type { SessionDatabase } from './database'
import { SESSION_META_ID, sessionMeta } from './schema'

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
