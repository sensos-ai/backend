export type CatalogMigration = {
  id: number
  sql: string
}

export const catalogMigrations: CatalogMigration[] = [
  {
    id: 1,
    sql: `
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY NOT NULL,
        actor_id TEXT UNIQUE,
        title TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_opened_at INTEGER,
        deleted_at INTEGER,
        revision INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX sessions_updated_at_idx ON sessions(updated_at);
      CREATE INDEX sessions_deleted_at_idx ON sessions(deleted_at);
    `,
  },
  {
    id: 2,
    sql: `
      ALTER TABLE sessions
        ADD COLUMN transcript_revision INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE messages (
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        role TEXT NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (session_id, id)
      );
      CREATE UNIQUE INDEX messages_session_sequence_unique
        ON messages(session_id, sequence);
    `,
  },
  {
    id: 3,
    sql: `
      ALTER TABLE sessions ADD COLUMN cwd TEXT;
      CREATE INDEX sessions_cwd_updated_at_idx
        ON sessions(cwd, updated_at);
    `,
  },
]
