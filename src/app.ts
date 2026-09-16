import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { setTimeout as sleep } from 'node:timers/promises'
import { streamText } from 'hono/streaming'
import {
  LATEST_SENSOS_PROTOCOL_VERSION,
  SENSOS_PROTOCOL_VERSIONS,
} from '@sensos-ai/protocol/core'

const app = new Hono()
app.use('*', cors())

app.get('/', c => {
  return streamText(c, async stream => {
    const chunks = ['Hello', 'Hono!', 'Bun!', 'Rivetkit!', 'Node.js!']

    c.req.raw.signal.addEventListener('abort', _e => {
      console.log('Client aborted the request')
      stream.abort()
    })

    stream.onAbort(() => {
      console.log('Stream aborted', stream.aborted)
    })

    for (const chunk of chunks) {
      if (stream.aborted) {
        console.log('Stream aborted', stream.aborted, chunk)
        // break
      }
      try {
        await stream.write(chunk)
        await sleep(1000, undefined, { signal: c.req.raw.signal })
      } catch (error: any) {
        if (error instanceof Error && error.name === 'AbortError') {
          console.log('AbortError', error.message)
          continue
        }
      }
      console.log('Writing chunk', chunk)
    }

    await stream.close()
  })
})

app.get('/health', c => c.text('OK'))

app.get('/api/protocol', c =>
  c.json({
    protocolVersion: LATEST_SENSOS_PROTOCOL_VERSION,
    supportedProtocolVersions: SENSOS_PROTOCOL_VERSIONS,
  })
)

export default app
