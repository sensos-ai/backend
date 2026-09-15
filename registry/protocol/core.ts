import { z } from 'zod'

export const SENSOS_PROTOCOL_VERSION = 1 as const

export const protocolVersionSchema = z.literal(SENSOS_PROTOCOL_VERSION)

export const sessionActorKeySchema = z.tuple([
  z.string().min(1),
  z.string().min(1),
  z.string().min(1),
])

export type SessionActorKey = z.infer<typeof sessionActorKeySchema>

export function sessionActorKey(input: {
  tenantId: string
  userId: string
  sessionId: string
}): SessionActorKey {
  return sessionActorKeySchema.parse([
    input.tenantId,
    input.userId,
    input.sessionId,
  ])
}

export const protocolErrorCodeSchema = z.enum([
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'invalid_request',
  'protocol_mismatch',
  'credentials_required',
  'unavailable',
  'internal',
])

export const protocolErrorSchema = z.object({
  code: protocolErrorCodeSchema,
  message: z.string(),
  retryable: z.boolean().default(false),
  details: z.record(z.string(), z.unknown()).optional(),
})

export type ProtocolError = z.infer<typeof protocolErrorSchema>
