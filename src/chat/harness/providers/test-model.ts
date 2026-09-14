import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'

type StreamPart =
  Awaited<
    ReturnType<
      Extract<
        NonNullable<
          ConstructorParameters<typeof MockLanguageModelV4>[0]
        >['doStream'],
        (...args: never[]) => unknown
      >
    >
  > extends { stream: ReadableStream<infer Part> }
    ? Part
    : never

export const TEST_MODEL_ENV = 'SENSOS_USE_TEST_MODEL'
export const TEST_MODEL_CHUNK_DELAY_MS = 40

const TOOL_CALL_ID = 'test-tool-call-1'
const TOOL_NAME = 'bash'
const TOOL_INPUT = JSON.stringify({ command: 'pwd' })
const FIRST_REASONING =
  'I will exercise the harness tool path before producing the final response.'
const FIRST_TEXT = 'Inspecting the sandbox workspace with a tool. '
const FINAL_REASONING =
  'The simulated tool completed, so I can now produce the final response.'
const FINAL_TEXT =
  'The test model completed a streamed reasoning, text, and tool-call sequence.'

const usage = {
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 1, text: 1, reasoning: 1 },
}

export function testModelEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env
): boolean {
  return env[TEST_MODEL_ENV]?.trim() === '1'
}

function containsToolResult(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsToolResult)
  if (!value || typeof value !== 'object') return false

  const record = value as Record<string, unknown>
  if (
    record.type === 'tool-result' &&
    record.toolCallId === TOOL_CALL_ID
  ) {
    return true
  }
  return Object.values(record).some(containsToolResult)
}

function deltas(
  type: 'reasoning-delta' | 'text-delta',
  id: string,
  text: string
): StreamPart[] {
  return text.split(/(?<= )/).map(delta => ({ type, id, delta }))
}

function firstStepChunks(): StreamPart[] {
  return [
    { type: 'reasoning-start', id: 'reasoning-1' },
    ...deltas('reasoning-delta', 'reasoning-1', FIRST_REASONING),
    { type: 'reasoning-end', id: 'reasoning-1' },
    { type: 'text-start', id: 'text-1' },
    ...deltas('text-delta', 'text-1', FIRST_TEXT),
    { type: 'text-end', id: 'text-1' },
    {
      type: 'tool-input-start',
      id: TOOL_CALL_ID,
      toolName: TOOL_NAME,
    },
    {
      type: 'tool-input-delta',
      id: TOOL_CALL_ID,
      delta: TOOL_INPUT.slice(0, 10),
    },
    {
      type: 'tool-input-delta',
      id: TOOL_CALL_ID,
      delta: TOOL_INPUT.slice(10),
    },
    { type: 'tool-input-end', id: TOOL_CALL_ID },
    {
      type: 'tool-call',
      toolCallId: TOOL_CALL_ID,
      toolName: TOOL_NAME,
      input: TOOL_INPUT,
    },
    {
      type: 'finish',
      finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
      usage,
    },
  ]
}

function finalStepChunks(): StreamPart[] {
  return [
    { type: 'reasoning-start', id: 'reasoning-2' },
    ...deltas('reasoning-delta', 'reasoning-2', FINAL_REASONING),
    { type: 'reasoning-end', id: 'reasoning-2' },
    { type: 'text-start', id: 'text-2' },
    ...deltas('text-delta', 'text-2', FINAL_TEXT),
    { type: 'text-end', id: 'text-2' },
    {
      type: 'finish',
      finishReason: { unified: 'stop', raw: 'stop' },
      usage,
    },
  ]
}

/**
 * Deterministic local model that drives the real agent loop through streamed
 * reasoning, text, a sandbox tool call/result, and a final streamed response.
 */
export function createTestLanguageModel(
  options: { chunkDelayInMs?: number } = {}
): MockLanguageModelV4 {
  const chunkDelayInMs =
    options.chunkDelayInMs ?? TEST_MODEL_CHUNK_DELAY_MS

  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: 'text', text: FINAL_TEXT }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage,
      warnings: [],
    }),
    doStream: async options => {
      const stream = simulateReadableStream({
        initialDelayInMs: 0,
        chunkDelayInMs,
        chunks: containsToolResult(options.prompt)
          ? finalStepChunks()
          : firstStepChunks(),
      })
      if (!options.abortSignal) {
        return { stream }
      }

      const reader = stream.getReader()
      let aborted = false
      let controller:
        | ReadableStreamDefaultController<StreamPart>
        | undefined
      const onAbort = () => {
        if (aborted) return
        aborted = true
        controller?.error(new Error('Test model provider aborted'))
      }
      if (options.abortSignal.aborted) onAbort()
      return {
        stream: new ReadableStream<StreamPart>({
          start(value) {
            controller = value
            if (aborted) {
              value.error(new Error('Test model provider aborted'))
              return
            }
            options.abortSignal?.addEventListener('abort', onAbort, {
              once: true,
            })
          },
          async pull(value) {
            const next = await reader.read()
            if (aborted) return
            if (next.done) value.close()
            else value.enqueue(next.value)
          },
          async cancel(reason) {
            options.abortSignal?.removeEventListener('abort', onAbort)
            await reader.cancel(reason)
          },
        }),
      }
    },
  })
}
