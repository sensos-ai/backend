import { event } from 'rivetkit'
import type { z } from 'zod'

export * from './queue'

export function createEvent<T extends z.ZodType, TContext = any>(
  schema: T
) {
  return event<z.input<T>, TContext>({
    schema,
  })
}
