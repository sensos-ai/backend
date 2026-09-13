import type { InferDatabaseClient, AnyDatabaseProvider } from 'rivetkit/db'
import { db } from 'rivetkit/db/drizzle'
import migrations from './drizzle/migrations.js'
import { schema } from './schema'

export const sessionDatabase = db({
  schema,
  migrations,
}) satisfies AnyDatabaseProvider

export type SessionDatabaseProvider = typeof sessionDatabase
export type SessionDatabase = InferDatabaseClient<typeof sessionDatabase>
