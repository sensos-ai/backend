import type { UIMessageChunk } from 'ai'
import { and, asc, eq, gt } from 'drizzle-orm'
import type { SessionDatabase } from './database'
import { runFrames } from './schema'

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
