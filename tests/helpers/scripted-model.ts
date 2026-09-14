import type {
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
} from '@ai-sdk/provider'
import { MockLanguageModelV4 } from 'ai/test'
import type {
  ScriptedChunk,
  ScriptedRequestExpectation,
  ScriptedScenario,
  ScriptedTurn,
} from '../fixtures/llm/scenario'

export type ScriptedRequestSummary = {
  turn: number
  modelId: string
  prompt: string
  toolResults: Array<{ toolCallId: string; toolName: string }>
}

type Deferred = {
  promise: Promise<void>
  resolve: () => void
}

function deferred(): Deferred {
  let resolve = () => {}
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

function walk(
  value: unknown,
  visit: (record: Record<string, unknown>) => void
) {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit)
    return
  }
  if (!value || typeof value !== 'object') return
  const record = value as Record<string, unknown>
  visit(record)
  for (const item of Object.values(record)) walk(item, visit)
}

function summarize(
  options: LanguageModelV4CallOptions,
  modelId: string,
  turn: number
): ScriptedRequestSummary {
  const text: string[] = []
  const toolResults: ScriptedRequestSummary['toolResults'] = []
  walk(options.prompt, record => {
    if (record.type === 'text' && typeof record.text === 'string') {
      text.push(record.text)
    }
    if (
      record.type === 'tool-result' &&
      typeof record.toolCallId === 'string' &&
      typeof record.toolName === 'string'
    ) {
      toolResults.push({
        toolCallId: record.toolCallId,
        toolName: record.toolName,
      })
    }
  })
  return { turn, modelId, prompt: text.join('\n'), toolResults }
}

function mismatch(
  expectation: ScriptedRequestExpectation | undefined,
  actual: ScriptedRequestSummary
): string | undefined {
  if (!expectation) return
  if (expectation.modelId && expectation.modelId !== actual.modelId) {
    return `model ${JSON.stringify(expectation.modelId)}`
  }
  if (
    expectation.promptContains &&
    !actual.prompt.includes(expectation.promptContains)
  ) {
    return `prompt containing ${JSON.stringify(expectation.promptContains)}`
  }
  if (
    expectation.promptExcludes &&
    actual.prompt.includes(expectation.promptExcludes)
  ) {
    return `prompt excluding ${JSON.stringify(expectation.promptExcludes)}`
  }
  if (expectation.toolResult) {
    const found = actual.toolResults.some(
      result =>
        result.toolCallId === expectation.toolResult?.toolCallId &&
        (!expectation.toolResult.toolName ||
          result.toolName === expectation.toolResult.toolName)
    )
    if (!found) {
      return `tool result ${JSON.stringify(expectation.toolResult)}`
    }
  }
}

export class ScriptedScenarioController {
  readonly requests: ScriptedRequestSummary[] = []
  readonly aborts: ScriptedRequestSummary[] = []
  readonly #scenario: ScriptedScenario
  readonly #gates = new Map<string, Deferred>()
  readonly #requestWaiters = new Set<() => void>()
  readonly #abortWaiters = new Set<() => void>()
  #nextTurn = 0
  #stopped = false

  constructor(scenario: ScriptedScenario) {
    this.#scenario = structuredClone(scenario)
  }

  consume(options: LanguageModelV4CallOptions, modelId: string) {
    if (this.#stopped)
      throw new Error(`Scenario ${this.#scenario.name} is stopped`)
    const index = this.#nextTurn++
    const turn = this.#scenario.turns[index]
    const actual = summarize(options, modelId, index)
    this.requests.push(actual)
    for (const wake of this.#requestWaiters) wake()
    if (!turn) {
      throw new Error(
        `Scripted scenario ${this.#scenario.name} received unexpected request for turn ${index}: ${JSON.stringify(actual)}`
      )
    }
    const expected = mismatch(turn.expect, actual)
    if (expected) {
      throw new Error(
        `Scripted scenario ${this.#scenario.name} turn ${index} expected ${expected}; actual ${JSON.stringify(actual)}`
      )
    }
    return { turn, actual }
  }

  gate(name: string): Promise<void> {
    let gate = this.#gates.get(name)
    if (!gate) {
      gate = deferred()
      this.#gates.set(name, gate)
    }
    return gate.promise
  }

  release(name: string): void {
    let gate = this.#gates.get(name)
    if (!gate) {
      gate = deferred()
      this.#gates.set(name, gate)
    }
    gate.resolve()
  }

  recordAbort(actual: ScriptedRequestSummary): void {
    if (this.aborts.includes(actual)) return
    this.aborts.push(actual)
    for (const wake of this.#abortWaiters) wake()
  }

  waitForRequest(count = 1, timeoutMs = 2_000) {
    return this.#waitFor(
      () => this.requests.length >= count,
      this.#requestWaiters,
      `request ${count}`,
      timeoutMs
    )
  }

  waitForAbort(count = 1, timeoutMs = 2_000) {
    return this.#waitFor(
      () => this.aborts.length >= count,
      this.#abortWaiters,
      `abort ${count}`,
      timeoutMs
    )
  }

  async #waitFor(
    ready: () => boolean,
    waiters: Set<() => void>,
    description: string,
    timeoutMs: number
  ): Promise<void> {
    if (ready()) return
    await new Promise<void>((resolve, reject) => {
      const done = () => {
        if (!ready()) return
        clearTimeout(timer)
        waiters.delete(done)
        resolve()
      }
      const timer = setTimeout(() => {
        waiters.delete(done)
        reject(
          new Error(
            `Timed out waiting for ${description} in scenario ${this.#scenario.name}`
          )
        )
      }, timeoutMs)
      waiters.add(done)
    })
  }

  assertConsumed(): void {
    const missing = this.#scenario.turns
      .slice(this.#nextTurn)
      .findIndex(turn => turn.required !== false)
    if (missing >= 0) {
      throw new Error(
        `Scripted scenario ${this.#scenario.name} did not consume required turn ${this.#nextTurn + missing}`
      )
    }
  }

  stop(): void {
    if (this.#stopped) return
    this.#stopped = true
    for (const gate of this.#gates.values()) gate.resolve()
  }
}

export async function streamScriptedTurn(
  turn: ScriptedTurn,
  actual: ScriptedRequestSummary,
  controller: ScriptedScenarioController,
  signal: AbortSignal | undefined,
  options: { allowMalformed?: boolean } = {}
): Promise<ReadableStream<LanguageModelV4StreamPart>> {
  let streamController: ReadableStreamDefaultController<LanguageModelV4StreamPart>
  let aborted = signal?.aborted ?? false
  const onAbort = () => {
    if (aborted) return
    aborted = true
    controller.recordAbort(actual)
    streamController?.error(
      new DOMException('The operation was aborted', 'AbortError')
    )
  }
  if (aborted) controller.recordAbort(actual)

  return new ReadableStream({
    start(value) {
      streamController = value
      signal?.addEventListener('abort', onAbort, { once: true })
      if (aborted) {
        value.error(
          new DOMException('The operation was aborted', 'AbortError')
        )
        return
      }
      void (async () => {
        try {
          for (const chunk of turn.chunks) {
            if (aborted) return
            if (chunk.type === 'hold') {
              await controller.gate(chunk.gate)
              continue
            }
            if (chunk.type === 'throw') throw new Error(chunk.message)
            if (chunk.type === 'malformed') {
              if (!options.allowMalformed) {
                throw new Error(
                  'Malformed chunks require the HTTP gateway'
                )
              }
              value.enqueue(chunk as unknown as LanguageModelV4StreamPart)
              continue
            }
            value.enqueue(chunk)
          }
          if (!aborted) value.close()
        } catch (error) {
          if (!aborted) value.error(error)
        } finally {
          signal?.removeEventListener('abort', onAbort)
        }
      })()
    },
    cancel() {
      onAbort()
    },
  })
}

export function createScriptedLanguageModel(
  scenario: ScriptedScenario,
  options: { modelId?: string } = {}
) {
  const controller = new ScriptedScenarioController(scenario)
  const modelId = options.modelId ?? 'scripted-model'
  const model = new MockLanguageModelV4({
    provider: 'scripted',
    modelId,
    doStream: async call => {
      const consumed = controller.consume(call, modelId)
      return {
        stream: await streamScriptedTurn(
          consumed.turn,
          consumed.actual,
          controller,
          call.abortSignal
        ),
      }
    },
  })
  return { model, controller }
}

export type { ScriptedChunk }
