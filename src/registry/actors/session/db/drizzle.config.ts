import { defineConfig } from 'rivetkit/db/drizzle'

export default defineConfig({
  schema: './src/registry/actors/session/db/schema.ts',
  out: './src/registry/actors/session/db/drizzle',
})
