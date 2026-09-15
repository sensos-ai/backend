const RIVET_PREFIX = '/api/rivet'
const STREAMS_PREFIX = '/durable-streams'

type GatewayRoute = {
  target: URL
  websocket: boolean
}

export type WebSocketProxyData = {
  upstream: WebSocket
  pending: Array<string | ArrayBuffer>
}

const WebSocketWithOptions = WebSocket as unknown as new (
  url: string | URL,
  options?: Bun.WebSocketOptions
) => WebSocket

function stripPrefix(pathname: string, prefix: string): string {
  const stripped = pathname.slice(prefix.length)
  return stripped.startsWith('/') ? stripped : `/${stripped}`
}

function targetUrl(source: URL, base: string, pathname: string): URL {
  const target = new URL(base)
  target.pathname = pathname
  target.search = source.search
  return target
}

export function resolvePublicGatewayRoute(
  requestUrl: string,
  options: { engineEndpoint: string; streamsEndpoint: string }
): GatewayRoute | undefined {
  const source = new URL(requestUrl)
  if (
    source.pathname === RIVET_PREFIX ||
    source.pathname.startsWith(`${RIVET_PREFIX}/`)
  ) {
    return {
      target: targetUrl(
        source,
        options.engineEndpoint,
        stripPrefix(source.pathname, RIVET_PREFIX)
      ),
      websocket: true,
    }
  }
  if (
    source.pathname === STREAMS_PREFIX ||
    source.pathname.startsWith(`${STREAMS_PREFIX}/`)
  ) {
    // Rivet Services owns the /durable-streams prefix. Keep it when
    // forwarding so clients can use the public server origin as their base.
    return {
      target: targetUrl(source, options.streamsEndpoint, source.pathname),
      websocket: false,
    }
  }
  return undefined
}

function websocketHeaders(request: Request): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [name, value] of request.headers) {
    if (
      name === 'connection' ||
      name === 'host' ||
      name === 'upgrade' ||
      name.startsWith('sec-websocket-')
    ) {
      continue
    }
    headers[name] = value
  }
  return headers
}

function websocketProtocols(request: Request): string[] | undefined {
  const protocols = request.headers
    .get('sec-websocket-protocol')
    ?.split(',')
    .map(value => value.trim())
    .filter(Boolean)
  return protocols?.length ? protocols : undefined
}

function validCloseCode(code: number): number {
  return code === 1000 || (code >= 3000 && code <= 4999) ? code : 1011
}

function copyMessage(message: Buffer): ArrayBuffer {
  const copy = new Uint8Array(message.byteLength)
  copy.set(message)
  return copy.buffer
}

export function createPublicGateway(options: {
  appFetch: (request: Request) => Response | Promise<Response>
  engineEndpoint: string
  streamsEndpoint: string
}) {
  return {
    async fetch(
      request: Request,
      server: Bun.Server<WebSocketProxyData>
    ): Promise<Response | undefined> {
      const route = resolvePublicGatewayRoute(request.url, options)
      if (!route) return options.appFetch(request)

      const isUpgrade =
        request.headers.get('upgrade')?.toLowerCase() === 'websocket'
      if (route.websocket && isUpgrade) {
        const target = new URL(route.target)
        target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:'
        const upstream = new WebSocketWithOptions(target, {
          headers: websocketHeaders(request),
          protocols: websocketProtocols(request),
        })
        upstream.binaryType = 'arraybuffer'
        const pending: Array<string | ArrayBuffer> = []
        const upgraded = server.upgrade(request, {
          data: { upstream, pending },
        })
        if (!upgraded) {
          upstream.close()
          return new Response('WebSocket upgrade failed', { status: 400 })
        }
        return undefined
      }

      return fetch(new Request(route.target, request))
    },
    websocket: {
      data: {} as WebSocketProxyData,
      open(client: Bun.ServerWebSocket<WebSocketProxyData>) {
        const { upstream, pending } = client.data
        upstream.addEventListener('open', () => {
          for (const message of pending) upstream.send(message)
          pending.length = 0
        })
        upstream.addEventListener('message', event => {
          client.send(event.data)
        })
        upstream.addEventListener('close', event => {
          client.close(validCloseCode(event.code), event.reason)
        })
        upstream.addEventListener('error', () => {
          client.close(1011, 'Upstream WebSocket connection failed')
        })
      },
      message(
        client: Bun.ServerWebSocket<WebSocketProxyData>,
        message: string | Buffer
      ) {
        const { upstream, pending } = client.data
        const outgoing =
          typeof message === 'string' ? message : copyMessage(message)
        if (upstream.readyState === WebSocket.OPEN) upstream.send(outgoing)
        else if (upstream.readyState === WebSocket.CONNECTING)
          pending.push(outgoing)
      },
      close(
        client: Bun.ServerWebSocket<WebSocketProxyData>,
        code: number,
        reason: string
      ) {
        const upstream = client.data.upstream
        if (
          upstream.readyState === WebSocket.OPEN ||
          upstream.readyState === WebSocket.CONNECTING
        ) {
          upstream.close(validCloseCode(code), reason)
        }
      },
    },
  }
}
