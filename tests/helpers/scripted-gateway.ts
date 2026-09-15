import type { LanguageModelV4StreamPart } from '@ai-sdk/provider'
import type {
  ScriptedChunk,
  ScriptedScenario,
} from '../fixtures/llm/scenario'
import {
  ScriptedScenarioController,
  streamScriptedTurn,
} from './scripted-model'

export type ScriptedGateway = {
  url: string
  requests: ScriptedScenarioController['requests']
  aborts: ScriptedScenarioController['aborts']
  waitForRequest: ScriptedScenarioController['waitForRequest']
  waitForAbort: ScriptedScenarioController['waitForAbort']
  release: ScriptedScenarioController['release']
  assertConsumed: ScriptedScenarioController['assertConsumed']
  stop: () => Promise<void>
}

function eventStream(
  stream: ReadableStream<LanguageModelV4StreamPart>
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return stream.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        const scriptedChunk = chunk as ScriptedChunk
        if (scriptedChunk.type === 'malformed') {
          controller.enqueue(
            encoder.encode(
              `data: ${scriptedChunk.data ?? '{invalid-json'}\n\n`
            )
          )
          return
        }
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`)
        )
      },
    })
  )
}

export function startScriptedGateway(
  scenario: ScriptedScenario
): ScriptedGateway {
  const controller = new ScriptedScenarioController(scenario)
  let stopped = false
  let server: ReturnType<typeof Bun.serve>
  for (let attempt = 0; ; attempt++) {
    try {
      server = Bun.serve({
        hostname: '127.0.0.1',
        port: 10_000 + Math.floor(Math.random() * 40_000),
        idleTimeout: 60,
        async fetch(request) {
          const url = new URL(request.url)
          if (
            request.method !== 'POST' ||
            url.pathname !== '/language-model'
          ) {
            return new Response('Not found', { status: 404 })
          }
          let body: unknown
          try {
            body = await request.json()
          } catch {
            return Response.json(
              { error: 'Expected a JSON request' },
              { status: 400 }
            )
          }
          const modelId =
            request.headers.get('ai-language-model-id') ?? 'unknown'
          const streaming =
            request.headers.get('ai-language-model-streaming') === 'true'
          try {
            const call = {
              ...(body as Record<string, unknown>),
              abortSignal: request.signal,
            }
            const consumed = controller.consume(
              call as Parameters<ScriptedScenarioController['consume']>[0],
              modelId
            )
            const stream = await streamScriptedTurn(
              consumed.turn,
              consumed.actual,
              controller,
              request.signal,
              { allowMalformed: true }
            )
            if (!streaming) {
              const chunks = await Array.fromAsync(stream)
              const text = chunks
                .filter(chunk => chunk.type === 'text-delta')
                .map(chunk => chunk.delta)
                .join('')
              const finish = chunks.find(chunk => chunk.type === 'finish')
              return Response.json({
                content: [{ type: 'text', text }],
                finishReason: finish?.finishReason ?? {
                  unified: 'stop',
                  raw: 'stop',
                },
                usage: finish?.usage,
                warnings: [],
              })
            }
            return new Response(eventStream(stream), {
              headers: {
                'content-type': 'text/event-stream',
                'cache-control': 'no-cache',
                connection: 'keep-alive',
              },
            })
          } catch (error) {
            return Response.json(
              {
                error: {
                  type: 'invalid_request_error',
                  message:
                    error instanceof Error ? error.message : String(error),
                },
              },
              { status: 400 }
            )
          }
        },
      })
      break
    } catch (error) {
      if (attempt >= 49) throw error
    }
  }

  return {
    url: `http://${server.hostname}:${server.port}`,
    requests: controller.requests,
    aborts: controller.aborts,
    waitForRequest: controller.waitForRequest.bind(controller),
    waitForAbort: controller.waitForAbort.bind(controller),
    release: controller.release.bind(controller),
    assertConsumed: controller.assertConsumed.bind(controller),
    async stop() {
      if (stopped) return
      stopped = true
      controller.stop()
      await server.stop(true)
    },
  }
}
