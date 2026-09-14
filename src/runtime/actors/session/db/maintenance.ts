import type { SessionDatabase } from './database'
import { messages, runFrames, runs, sessionMeta } from './schema'

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
