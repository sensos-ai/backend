import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import initialMigration from '@/registry/actors/session/db/drizzle/0000_old_luckman.sql' with {
  type: 'text',
}
import durableChatMigration from '@/registry/actors/session/db/drizzle/0001_tidy_lockjaw.sql' with {
  type: 'text',
}
import runMetadataMigration from '@/registry/actors/session/db/drizzle/0002_violet_blindfold.sql' with {
  type: 'text',
}
import sessionTitleMigration from '@/registry/actors/session/db/drizzle/0003_lyrical_morlocks.sql' with {
  type: 'text',
}
import runModelMigration from '@/registry/actors/session/db/drizzle/0004_outstanding_bullseye.sql' with {
  type: 'text',
}
import removeResolvedModelMigration from '@/registry/actors/session/db/drizzle/0005_wealthy_silverclaw.sql' with {
  type: 'text',
}

function applyMigration(database: Database, migration: string) {
  for (const statement of migration.split('--> statement-breakpoint')) {
    if (statement.trim()) database.run(statement)
  }
}

describe('session actor migrations', () => {
  test('upgrades a populated database and enforces durable frame identity', () => {
    const database = new Database(':memory:')
    applyMigration(database, initialMigration)
    database.run(
      `INSERT INTO runs (id, idempotency_id, status, created_at)
       VALUES ('run_old', 'idem_old', 'completed', 1)`
    )

    applyMigration(database, durableChatMigration)
    applyMigration(database, runMetadataMigration)
    applyMigration(database, sessionTitleMigration)
    applyMigration(database, runModelMigration)
    applyMigration(database, removeResolvedModelMigration)

    const upgraded = database
      .query(
        `SELECT user_message_id, assistant_message_id, finish_reason,
                model, steps, total_usage,
                response_metadata, title
         FROM runs
         LEFT JOIN session_meta ON session_meta.singleton_id = 1
         WHERE runs.id = 'run_old'`
      )
      .get() as Record<string, unknown>
    expect(upgraded).toEqual({
      user_message_id: '',
      assistant_message_id: '',
      finish_reason: null,
      model: 'openai/gpt-5.6-terra',
      steps: null,
      total_usage: null,
      response_metadata: null,
      title: null,
    })
    const runColumns = database
      .query(`PRAGMA table_info('runs')`)
      .all() as Array<{ name: string }>
    expect(runColumns.map(column => column.name)).not.toContain(
      'resolved_model'
    )

    database.run(
      `INSERT INTO run_frames (run_id, sequence, payload, created_at)
       VALUES ('run_old', 0, '{"type":"finish"}', 2)`
    )
    expect(() =>
      database.run(
        `INSERT INTO run_frames (run_id, sequence, payload, created_at)
         VALUES ('run_old', 0, '{"type":"finish"}', 3)`
      )
    ).toThrow()

    database.close()
  })
})
