import { workflow } from 'rivetkit/workflow'
import { joinSignals } from 'rivetkit/utils'
import {
  createAgentUIStream,
  type FinishReason,
  type LanguageModelUsage,
  type UIMessage,
  type UIMessageChunk,
  type UIMessageStreamOutcome,
} from 'ai'
import { createHarness } from '@/lib/harness'
import { createProviderOptions } from '@/lib/harness/providers'
import { createAgentOsSandbox } from '@/lib/agentos-sandbox'
import { createIdGeneratorWithPrefix, errorMessage } from '@/lib/utils'
import {
  appendRunFrame,
  finalizeRun,
  getRun,
  listMessages,
  setSessionTitle,
  submitRun,
  type RunStepMetadata,
  updateRun,
} from './db'
import { toChatStatus } from './config'
import type { RunCompletion } from './config'
import {
  generateSessionTitle,
  shouldGenerateSessionTitle,
  userMessageText,
} from './title'
import type { RunWorkflow } from './types'
import {
  configuredSessionCatalog,
  updateCatalogTitle,
} from '@/sensos/catalog'

const terminalStatuses = new Set([
  'cancelled',
  'completed',
  'failed',
  'interrupted',
])
const createMessageId = createIdGeneratorWithPrefix('msg')
const createRunId = createIdGeneratorWithPrefix('run')

async function projectTranscript(
  sessionId: string,
  revision: number,
  messages: UIMessage[],
  log: { warn: (value: unknown) => void }
): Promise<void> {
  try {
    await configuredSessionCatalog()?.replaceMessages(
      sessionId,
      revision,
      messages
    )
  } catch (error) {
    log.warn({
      msg: 'local transcript projection failed',
      sessionId,
      revision,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

const addCount = (left?: number, right?: number) =>
  left == null && right == null ? undefined : (left ?? 0) + (right ?? 0)

function aggregateUsage(steps: RunStepMetadata[]): LanguageModelUsage {
  return steps.reduce<LanguageModelUsage>(
    (total, step) => ({
      inputTokens: addCount(total.inputTokens, step.usage.inputTokens),
      inputTokenDetails: {
        noCacheTokens: addCount(
          total.inputTokenDetails.noCacheTokens,
          step.usage.inputTokenDetails.noCacheTokens
        ),
        cacheReadTokens: addCount(
          total.inputTokenDetails.cacheReadTokens,
          step.usage.inputTokenDetails.cacheReadTokens
        ),
        cacheWriteTokens: addCount(
          total.inputTokenDetails.cacheWriteTokens,
          step.usage.inputTokenDetails.cacheWriteTokens
        ),
      },
      outputTokens: addCount(total.outputTokens, step.usage.outputTokens),
      outputTokenDetails: {
        textTokens: addCount(
          total.outputTokenDetails.textTokens,
          step.usage.outputTokenDetails.textTokens
        ),
        reasoningTokens: addCount(
          total.outputTokenDetails.reasoningTokens,
          step.usage.outputTokenDetails.reasoningTokens
        ),
      },
      totalTokens: addCount(total.totalTokens, step.usage.totalTokens),
    }),
    {
      inputTokens: undefined,
      inputTokenDetails: {
        noCacheTokens: undefined,
        cacheReadTokens: undefined,
        cacheWriteTokens: undefined,
      },
      outputTokens: undefined,
      outputTokenDetails: {
        textTokens: undefined,
        reasoningTokens: undefined,
      },
      totalTokens: undefined,
    }
  )
}

export const runWorkflow: RunWorkflow = async context => {
  await context.loop('runs', async loop => {
    const queued = await loop.queue.next('next-run', {
      names: ['runs'],
      completable: true,
    })

    const submission = await loop.step('submit-run', async step => {
      const result = await submitRun(step.db, {
        runId: createRunId(),
        idempotencyId: queued.body.idempotencyId,
        model: queued.body.model,
        message: queued.body.message,
        assistantMessageId: createMessageId(),
      })

      if (result.created) {
        const catalog = configuredSessionCatalog()
        if (catalog) step.waitUntil(catalog.touch(step.state.sessionId))
        if (
          shouldGenerateSessionTitle({
            created: true,
            revision: result.revision,
            title: step.state.title,
          })
        ) {
          const prompt = userMessageText(queued.body.message)
          if (prompt) {
            const state = step.state
            const database = step.db
            const log = step.log
            step.waitUntil(
              (async () => {
                const title = await generateSessionTitle(prompt, {
                  features: state.config.features,
                })
                if (!title || state.title) return
                const session = catalog
                  ? await updateCatalogTitle(
                      catalog,
                      state.sessionId,
                      state.catalogRevision,
                      title
                    )
                  : undefined
                state.title = session?.title ?? title
                if (session) state.catalogRevision = session.revision
                await setSessionTitle(database, state.title)
                step.broadcast('titleChanged', { title: state.title })
              })().catch(error => {
                log.warn({
                  msg: 'session title generation failed',
                  error:
                    error instanceof Error ? error.message : String(error),
                })
              })
            )
          }
        }

        const messages = await listMessages(step.db)
        await projectTranscript(
          step.state.sessionId,
          result.revision,
          messages,
          step.log
        )
        step.broadcast('messagesChanged', {
          messages,
          revision: result.revision,
        })
        step.broadcast('statusChanged', {
          runId: result.run.id,
          runStatus: 'queued',
          status: toChatStatus('queued'),
        })
      }

      return {
        accepted: result.accepted,
        deduplicated: result.accepted && !result.created,
        runId: result.run.id,
        status: result.run.status,
        ...(!result.accepted ? { reason: 'session_busy' as const } : {}),
      } satisfies RunCompletion
    })

    await queued.complete(submission)
    if (!submission.accepted || submission.deduplicated) return

    await loop.step({
      name: 'execute-run',
      timeout: 0,
      maxRetries: 0,
      run: async step => {
        const run = await getRun(step.db, submission.runId)
        if (!run || terminalStatuses.has(run.status)) return

        let sequence = 0
        const publishFrame = async (chunk: UIMessageChunk) => {
          await appendRunFrame(step.db, run.id, sequence, chunk)
          step.broadcast('frame', { runId: run.id, seq: sequence, chunk })
          sequence += 1
        }
        const publishStatus = (
          runStatus: Parameters<typeof toChatStatus>[0],
          error?: string
        ) => {
          step.broadcast('statusChanged', {
            runId: run.id,
            runStatus,
            status: toChatStatus(runStatus),
            ...(error ? { error } : {}),
          })
        }

        if (run.status === 'cancel_requested') {
          const chunk: UIMessageChunk = {
            type: 'abort',
            reason: 'cancelled before execution',
          }
          const finalized = await finalizeRun(step.db, run.id, {
            status: 'cancelled',
            sequence,
            chunk,
          })
          step.broadcast('frame', { runId: run.id, seq: sequence, chunk })
          publishStatus('cancelled')
          const messages = await listMessages(step.db)
          await projectTranscript(
            step.state.sessionId,
            finalized.revision,
            messages,
            step.log
          )
          step.broadcast('messagesChanged', {
            messages,
            revision: finalized.revision,
          })
          return
        }

        const abortController = new AbortController()
        step.vars.activeRun = { runId: run.id, abortController }

        try {
          await updateRun(step.db, run.id, {
            status: 'running',
            error: null,
            startedAt: run.startedAt ?? new Date(),
          })
          publishStatus('running')

          const messages = await listMessages(step.db)
          const sandbox = createAgentOsSandbox({
            id: step.actorId,
            vm: step.vars.vm,
            cwd: step.state.config.guestCwd,
          })

          const harness = createHarness({
            sandbox,
            signal: abortController.signal,
            initialMessages: messages,
            model: queued.body.model,
            features: step.state.config.features,
            instructions: step.state.config.instructions,
            providerOptions: createProviderOptions({
              gateway: {
                byok: {
                  openai: [],
                },
              },
            }),
          })

          const signal = joinSignals(
            step.abortSignal,
            abortController.signal
          )

          let responseMessage: UIMessage | undefined
          const endState: {
            outcome: UIMessageStreamOutcome
            finishReason?: FinishReason
          } = { outcome: { status: 'unknown' } }
          const stepMetadata: RunStepMetadata[] = []

          const stream = await createAgentUIStream({
            agent: harness.agent,
            uiMessages: harness.initialMessages,
            abortSignal: signal,
            generateMessageId: () =>
              run.assistantMessageId || createMessageId(),
            onStepEnd: result => {
              stepMetadata.push({
                callId: result.callId,
                stepNumber: result.stepNumber,
                finishReason: result.finishReason,
                ...(result.rawFinishReason
                  ? { rawFinishReason: result.rawFinishReason }
                  : {}),
                usage: result.usage,
                ...(result.providerMetadata
                  ? { providerMetadata: result.providerMetadata }
                  : {}),
                response: {
                  id: result.response.id,
                  timestamp: result.response.timestamp.toISOString(),
                  modelId: result.response.modelId,
                },
              })
            },
            sendFinish: false,
            onEnd: event => {
              responseMessage = event.responseMessage
              endState.outcome = event.outcome
              endState.finishReason = event.finishReason
            },
          })

          for await (const chunk of stream) await publishFrame(chunk)

          let status: 'cancelled' | 'completed' | 'failed' | 'interrupted'
          let terminalChunk: UIMessageChunk
          let failure: string | undefined

          if (abortController.signal.aborted) {
            status = 'cancelled'
            terminalChunk = { type: 'abort', reason: 'cancelled' }
          } else if (
            step.abortSignal.aborted ||
            endState.outcome.status === 'aborted'
          ) {
            status = 'interrupted'
            terminalChunk = { type: 'abort', reason: 'interrupted' }
          } else if (endState.outcome.status === 'completed') {
            status = 'completed'
            terminalChunk = {
              type: 'finish',
              finishReason: endState.finishReason,
            }
          } else {
            status = 'failed'
            failure =
              endState.outcome.status === 'failed'
                ? errorMessage(
                    endState.outcome.error ?? 'Agent stream failed'
                  )
                : 'Agent stream ended without a terminal outcome'
            terminalChunk = { type: 'error', errorText: failure }
          }

          const finalized = await finalizeRun(step.db, run.id, {
            status,
            sequence,
            chunk: terminalChunk,
            responseMessage:
              status === 'completed' ? responseMessage : undefined,
            error: failure,
            finishReason:
              status === 'completed' ? endState.finishReason : undefined,
            steps: stepMetadata,
            totalUsage: aggregateUsage(stepMetadata),
            responseMetadata: stepMetadata.at(-1)?.response,
          })

          // finalizeRun commits the assistant message and terminal frame in one
          // transaction. Only publish the finish after that transaction lands.
          step.broadcast('frame', {
            runId: run.id,
            seq: sequence,
            chunk: terminalChunk,
          })
          if (status === 'completed') {
            const messages = await listMessages(step.db)
            await projectTranscript(
              step.state.sessionId,
              finalized.revision,
              messages,
              step.log
            )
            step.broadcast('messagesChanged', {
              messages,
              revision: finalized.revision,
            })
          }
          publishStatus(status, failure)
        } catch (error) {
          const failure = errorMessage(error)
          const status = abortController.signal.aborted
            ? 'cancelled'
            : step.abortSignal.aborted
              ? 'interrupted'
              : 'failed'
          const chunk: UIMessageChunk =
            status === 'failed'
              ? { type: 'error', errorText: failure }
              : { type: 'abort', reason: status }

          const finalized = await finalizeRun(step.db, run.id, {
            status,
            sequence,
            chunk,
            error: status === 'failed' ? failure : undefined,
          })
          step.broadcast('frame', { runId: run.id, seq: sequence, chunk })
          const messages = await listMessages(step.db)
          await projectTranscript(
            step.state.sessionId,
            finalized.revision,
            messages,
            step.log
          )
          step.broadcast('messagesChanged', {
            messages,
            revision: finalized.revision,
          })
          publishStatus(status, status === 'failed' ? failure : undefined)
        } finally {
          if (step.vars.activeRun?.runId === run.id) {
            step.vars.activeRun = undefined
          }
        }
      },
    })
  })
}

export default workflow(runWorkflow)
