import type { Client } from 'rivetkit/client'
import { createClient } from 'rivetkit/client'
import type { registry } from './actors/registry'
import { acquireRuntime, type RuntimeLease } from './client'
import { RUNTIME_ENDPOINT, RUNTIME_STREAMS_ENDPOINT } from './constants'

export const REGISTRY_ENDPOINT_ENV = 'SENSOS_REGISTRY_ENDPOINT'
export const STREAMS_URL_ENV = 'SENSOS_STREAMS_URL'

declare const __SENSOS_REGISTRY_ENDPOINT__: string
declare const __SENSOS_STREAMS_URL__: string

function builtEndpoint(value: string | undefined): string | undefined {
  return value?.trim() || undefined
}

const BUILT_ENGINE_ENDPOINT = builtEndpoint(
  typeof __SENSOS_REGISTRY_ENDPOINT__ === 'undefined'
    ? undefined
    : __SENSOS_REGISTRY_ENDPOINT__
)
const BUILT_STREAMS_ENDPOINT = builtEndpoint(
  typeof __SENSOS_STREAMS_URL__ === 'undefined'
    ? undefined
    : __SENSOS_STREAMS_URL__
)

export type RivetEngineTarget =
  | { kind: 'local' }
  | {
      kind: 'remote'
      endpoint: string
      streamsEndpoint: string
      token?: string
      namespace?: string
    }

export type RivetEngineConnection = {
  client: Client<typeof registry>
  endpoint: string
  streamsEndpoint: string
  release(): Promise<void>
}

function endpoint(value: string, label: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${label} must be an absolute HTTP(S) URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${label} must use HTTP or HTTPS`)
  }
  return parsed.toString().replace(/\/$/, '')
}

export function resolveRivetEngineTarget(
  options: {
    token?: string
    namespace?: string
    localEngine?: boolean
  } = {},
  env: Readonly<Record<string, string | undefined>> = process.env
): RivetEngineTarget {
  if (options.localEngine) return { kind: 'local' }
  const remoteEndpoint =
    env[REGISTRY_ENDPOINT_ENV]?.trim() || BUILT_ENGINE_ENDPOINT
  const remoteStreamsEndpoint =
    env[STREAMS_URL_ENV]?.trim() || BUILT_STREAMS_ENDPOINT

  if (!remoteEndpoint && !remoteStreamsEndpoint) {
    throw new Error(
      `Remote engine is not configured. Set ${REGISTRY_ENDPOINT_ENV} and ${STREAMS_URL_ENV}, or pass --local-engine.`
    )
  }
  if (!remoteEndpoint || !remoteStreamsEndpoint) {
    throw new Error(
      `Remote engine mode requires both ${REGISTRY_ENDPOINT_ENV} and ${STREAMS_URL_ENV}`
    )
  }

  return {
    kind: 'remote',
    endpoint: endpoint(remoteEndpoint, 'Remote engine endpoint'),
    streamsEndpoint: endpoint(
      remoteStreamsEndpoint,
      'Remote streams endpoint'
    ),
    ...(options.token ? { token: options.token } : {}),
    ...(options.namespace ? { namespace: options.namespace } : {}),
  }
}

/**
 * Owns the connection below chat/session semantics. Remote mode is a pure
 * Rivet HTTP/WebSocket client and never initializes the local supervisor.
 */
export async function connectRivetEngine(
  target: RivetEngineTarget,
  productRoot: string
): Promise<RivetEngineConnection> {
  let lease: RuntimeLease | undefined
  if (target.kind === 'local') {
    lease = acquireRuntime(productRoot)
    await lease.ready
  }

  const endpointValue =
    target.kind === 'local' ? RUNTIME_ENDPOINT : target.endpoint
  const streamsEndpoint =
    target.kind === 'local'
      ? RUNTIME_STREAMS_ENDPOINT
      : target.streamsEndpoint
  const client = createClient<typeof registry>({
    endpoint: endpointValue,
    ...(target.kind === 'remote' && target.token
      ? { token: target.token }
      : {}),
    ...(target.kind === 'remote' && target.namespace
      ? { namespace: target.namespace }
      : {}),
  })

  return {
    client,
    endpoint: endpointValue,
    streamsEndpoint,
    async release() {
      await lease?.release()
    },
  }
}
