import { z } from 'zod'

export const SENSOS_PROTOCOL_VERSIONS = [1] as const
export const LATEST_SENSOS_PROTOCOL_VERSION = SENSOS_PROTOCOL_VERSIONS[0]

export type SensosProtocolVersion =
  (typeof SENSOS_PROTOCOL_VERSIONS)[number]

export const protocolVersionSchema = z.number().int().positive()
export const supportedProtocolVersionsSchema = z
  .array(protocolVersionSchema)
  .min(1)

export const protocolDiscoverySchema = z.object({
  protocolVersion: protocolVersionSchema,
  supportedProtocolVersions: supportedProtocolVersionsSchema,
})

export type ProtocolDiscovery = z.infer<typeof protocolDiscoverySchema>

export function negotiateProtocolVersion(
  requested: readonly number[]
): SensosProtocolVersion | undefined {
  const requestedVersions = new Set(requested)
  return SENSOS_PROTOCOL_VERSIONS.find(version =>
    requestedVersions.has(version)
  )
}

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
