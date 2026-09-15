import app from './app'
import { createPublicGateway } from './runtime/public-gateway'
import {
  RUNTIME_ENDPOINT,
  RUNTIME_STREAMS_ENDPOINT,
} from './runtime/constants'

const port = Number(process.env.PORT ?? 5500)
const gateway = createPublicGateway({
  appFetch: app.fetch,
  engineEndpoint: RUNTIME_ENDPOINT,
  streamsEndpoint: RUNTIME_STREAMS_ENDPOINT,
})

const server = Bun.serve({
  hostname: '0.0.0.0',
  development: process.env.NODE_ENV === 'development',
  reusePort: true,
  port,
  fetch: gateway.fetch,
  websocket: gateway.websocket,
  idleTimeout: 0,
})

console.log(`[server]: running on ${new URL(server.url).origin} 🚀`)
