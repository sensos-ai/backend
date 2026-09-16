// packages/shared/src/core.ts
import { z } from "zod";
var SENSOS_PROTOCOL_VERSIONS = [1];
var LATEST_SENSOS_PROTOCOL_VERSION = SENSOS_PROTOCOL_VERSIONS[0];
var protocolVersionSchema = z.number().int().positive();
var supportedProtocolVersionsSchema = z.array(protocolVersionSchema).min(1);
var protocolDiscoverySchema = z.object({
  protocolVersion: protocolVersionSchema,
  supportedProtocolVersions: supportedProtocolVersionsSchema
});
function negotiateProtocolVersion(requested) {
  const requestedVersions = new Set(requested);
  return SENSOS_PROTOCOL_VERSIONS.find((version) => requestedVersions.has(version));
}
var sessionActorKeySchema = z.tuple([
  z.string().min(1),
  z.string().min(1),
  z.string().min(1)
]);
function sessionActorKey(input) {
  return sessionActorKeySchema.parse([
    input.tenantId,
    input.userId,
    input.sessionId
  ]);
}
var protocolErrorCodeSchema = z.enum([
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "invalid_request",
  "protocol_mismatch",
  "credentials_required",
  "unavailable",
  "internal"
]);
var protocolErrorSchema = z.object({
  code: protocolErrorCodeSchema,
  message: z.string(),
  retryable: z.boolean().default(false),
  details: z.record(z.string(), z.unknown()).optional()
});
// packages/shared/src/models.ts
import { z as z2 } from "zod";
var modelProviderSchema = z2.enum(["gateway", "codex"]);
var modelRefSchema = z2.object({
  provider: modelProviderSchema,
  modelId: z2.string().min(1)
});
var harnessFeaturesSchema = z2.object({
  useMockModel: z2.boolean()
});
// packages/shared/src/session.ts
import { z as z3 } from "zod";
var runStatusSchema = z3.enum([
  "queued",
  "running",
  "cancel_requested",
  "completed",
  "failed",
  "cancelled",
  "interrupted"
]);
var sessionInputSchema = z3.object({
  supportedProtocolVersions: supportedProtocolVersionsSchema,
  sessionId: z3.string().min(1),
  catalogRevision: z3.number().int().nonnegative().optional(),
  cwd: z3.string().min(1),
  model: modelRefSchema.optional(),
  instructions: z3.string().optional(),
  initialMessages: z3.array(z3.custom()).optional(),
  features: harnessFeaturesSchema.partial().optional()
});
// packages/shared/src/streams.ts
import { z as z4 } from "zod";
var runStreamCursorSchema = z4.string().min(1);
var runStreamName = (runId) => `sensos/runs/${encodeURIComponent(runId)}`;
export {
  LATEST_SENSOS_PROTOCOL_VERSION,
  SENSOS_PROTOCOL_VERSIONS,
  harnessFeaturesSchema,
  modelProviderSchema,
  modelRefSchema,
  negotiateProtocolVersion,
  protocolDiscoverySchema,
  protocolErrorCodeSchema,
  protocolErrorSchema,
  protocolVersionSchema,
  runStatusSchema,
  runStreamCursorSchema,
  runStreamName,
  sessionActorKey,
  sessionActorKeySchema,
  sessionInputSchema,
  supportedProtocolVersionsSchema
};
