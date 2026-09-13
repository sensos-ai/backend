import { defineConfig } from 'rivetkit/db/drizzle'

export default defineConfig({
  schema: './src/runtime/actors/session/db/schema.ts',
  out: './src/runtime/actors/session/db/drizzle',
})
