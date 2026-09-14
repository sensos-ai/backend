import { workflow } from 'rivetkit/workflow'
import { joinSignals } from 'rivetkit/utils'
import {
  createAgentUIStream,
  type FinishReason,
  type LanguageModelUsage,
  type UIMessage,
  type UIMessageChunk,
  type UIMessageStreamOutcome,
  isToolUIPart,
} from 'ai'
import { createHarness, createRunSteeringInput } from '@/chat/harness'
import {
  withOriginAttribution,
  type SteeringMessage,
} from '@/chat/harness'
import { createProviderOptions } from '@/chat/harness/providers'
import { createAgentOsSandbox } from '@/chat/agentos-sandbox'
import { createIdGeneratorWithPrefix, errorMessage } from '@/shared/utils'
import {
  appendRunFrame,
  appendMessageIfAbsent,
  finalizeRun,
  getRun,
  listMessages,
  messageExists,
  setSessionTitle,
  submitRun,
  type RunStepMetadata,
  updateRun,
} from './db'
import { toChatStatus } from './config'
import type { InboxMessage, RunCommand, RunCompletion } from './config'
import type { QueueResult } from './queue'
import type { SessionQueues } from './config'
import {
  generateSessionTitle,
  shouldGenerateSessionTitle,
  userMessageText,
} from './title'
import type { RunWorkflow } from './types'
import {
  configuredSessionCatalog,
  updateCatalogTitle,
} from '@/storage/session-catalog'

const terminalStatuses = new Set([
  'cancelled',
  'completed',
  'failed',
  'interrupted',
])
const createMessageId = createIdGeneratorWithPrefix('msg')
const createRunId = createIdGeneratorWithPrefix('run')

type SessionWorkflowContext = Parameters<RunWorkflow>[0]
type QueuedRun = QueueResult<SessionQueues, 'runs'>

function messageWithOrigin(inboxMessage: InboxMessage): UIMessage {
  const existingMetadata =
    inboxMessage.message.metadata &&
    typeof inboxMessage.message.metadata === 'object'
      ? inboxMessage.message.metadata
      : {}
  return {
    ...inboxMessage.message,
    metadata: {
      ...existingMetadata,
      sensosOrigin: inboxMessage.origin,
    },
  }
}

function toRunCommand(
  model: RunCommand['model'],
  inboxMessage: InboxMessage
): RunCommand {
  return {
    idempotencyId: inboxMessage.id,
    model,
    message: messageWithOrigin(inboxMessage),
  }
}

function isWaitingForHumanInput(messages: UIMessage[]): boolean {
  const latest = messages.at(-1)
  if (latest?.role !== 'assistant') return false
  return latest.parts.some(
    part =>
      isToolUIPart(part) &&
      part.state === 'approval-requested' &&
      part.approval.isAutomatic !== true
  )
}

async function routeInboxMessage(
  context: SessionWorkflowContext,
  inboxMessage: InboxMessage
): Promise<void> {
  await context.step('route-inbox', async step => {
    if (await messageExists(step.db, inboxMessage.message.id)) return
    const activeRun = step.vars.activeRun
    const shouldSteer =
      inboxMessage.priority === 'now' ||
      (inboxMessage.priority === 'adaptive' && activeRun !== undefined)

    if (shouldSteer && activeRun) {
      const message = messageWithOrigin(inboxMessage)
      const appended = await appendMessageIfAbsent(
        step.db,
        message,
        new Date(inboxMessage.createdAt)
      )
      if (appended.created) {
        const steeringMessage = {
          message,
          origin: inboxMessage.origin,
        }
        const accepted =
          inboxMessage.priority === 'now'
            ? activeRun.interrupt(steeringMessage)
            : activeRun.steering.push(steeringMessage)
        if (!accepted) {
          step.broadcast('deliveryRouted', {
            id: inboxMessage.id,
            status: 'refused',
            reason: 'not_active',
            origin: inboxMessage.origin,
          })
          return
        }
        const messages = await listMessages(step.db)
        await projectTranscript(
          step.state.sessionId,
          appended.revision,
          messages,
          step.log
        )
        step.broadcast('messagesChanged', {
          messages,
          revision: appended.revision,
        })
      }
      step.broadcast('deliveryRouted', {
        id: inboxMessage.id,
        status: 'steered',
        runId: activeRun.runId,
        origin: inboxMessage.origin,
      })
      return
    }

    if (
      inboxMessage.priority === 'now' &&
      isWaitingForHumanInput(await listMessages(step.db))
    ) {
      step.broadcast('deliveryRouted', {
        id: inboxMessage.id,
        status: 'refused',
        reason: 'waiting_for_input',
        origin: inboxMessage.origin,
      })
      return
    }

    await step.queue.send(
      'runs',
      toRunCommand(step.state.config.model, inboxMessage)
    )
    step.broadcast('deliveryRouted', {
      id: inboxMessage.id,
      status: 'queued',
      origin: inboxMessage.origin,
    })
  })
}

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

function completedPartsBeforeInterruptedStep(message?: UIMessage) {
  if (!message) return []
  const lastStepStart = message.parts.findLastIndex(
    part => part.type === 'step-start'
  )
  return lastStepStart < 0 ? [] : message.parts.slice(0, lastStepStart)
}

type AcceptedWork = {
  command: RunCommand
  submission: RunCompletion
}
type NextWork = (AcceptedWork & { kind: 'run' }) | { kind: 'inbox' }

async function acceptQueuedRun(
  context: SessionWorkflowContext,
  queued: QueuedRun
): Promise<AcceptedWork> {
  const submission = await context.step('submit-run', async step => {
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

    step.broadcast('deliveryRouted', {
      id: queued.body.idempotencyId,
      status: result.accepted ? 'started' : 'refused',
      runId: result.run.id,
      ...(!result.accepted ? { reason: 'session_busy' as const } : {}),
      origin: ((
        queued.body.message.metadata as Record<string, unknown> | undefined
      )?.sensosOrigin as InboxMessage['origin'] | undefined) ?? {
        type: 'system' as const,
      },
    })

    return {
      accepted: result.accepted,
      deduplicated: result.accepted && !result.created,
      runId: result.run.id,
      status: result.run.status,
      ...(!result.accepted ? { reason: 'session_busy' as const } : {}),
    } satisfies RunCompletion
  })

  await queued.complete(submission)
  return { command: queued.body, submission }
}

export const runWorkflow: RunWorkflow = async context => {
  await context.loop('runs', async loop => {
    const received = await loop.race('next-work', [
      {
        name: 'run',
        run: async branch => {
          const queued = await branch.queue.next('next-run', {
            names: ['runs'],
            completable: true,
          })
          return {
            kind: 'run' as const,
            ...(await acceptQueuedRun(branch, queued)),
          } satisfies NextWork as NextWork
        },
      },
      {
        name: 'inbox',
        run: async branch => {
          const queued = await branch.queue.next('next-inbox', {
            names: ['inbox'],
          })
          await routeInboxMessage(branch, queued.body)
          return { kind: 'inbox' as const } satisfies NextWork as NextWork
        },
      },
    ])

    if (received.value.kind === 'inbox') return
    const { command, submission } = received.value
    if (!submission.accepted || submission.deduplicated) return

    await loop.race(`execute-run-${submission.runId}`, [
      {
        name: 'execute',
        run: branch =>
          branch.step({
            name: 'execute-run',
            timeout: 0,
            maxRetries: 0,
            run: async step => {
              const run = await getRun(step.db, submission.runId)
              if (!run || terminalStatuses.has(run.status)) return

              let sequence = 0
              const publishFrame = async (chunk: UIMessageChunk) => {
                await appendRunFrame(step.db, run.id, sequence, chunk)
                step.broadcast('frame', {
                  runId: run.id,
                  seq: sequence,
                  chunk,
                })
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
                step.broadcast('frame', {
                  runId: run.id,
                  seq: sequence,
                  chunk,
                })
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
              const steering = createRunSteeringInput()
              let sliceAbortController = new AbortController()
              let acceptingInterrupts = true
              const interruptions: SteeringMessage[] = []
              step.vars.activeRun = {
                runId: run.id,
                abortController,
                steering,
                interrupt: message => {
                  if (!acceptingInterrupts) return false
                  interruptions.push(message)
                  sliceAbortController.abort('steered')
                  return true
                },
              }

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

                let sliceMessages = messages
                let completedAssistantParts: UIMessage['parts'] = []
                let responseMessage: UIMessage | undefined
                const stepMetadata: RunStepMetadata[] = []
                let endState: {
                  outcome: UIMessageStreamOutcome
                  finishReason?: FinishReason
                } = { outcome: { status: 'unknown' } }

                while (true) {
                  sliceAbortController = new AbortController()
                  const harness = createHarness({
                    sandbox,
                    signal: abortController.signal,
                    initialMessages: sliceMessages,
                    model: command.model,
                    features: step.state.config.features,
                    instructions: step.state.config.instructions,
                    providerOptions: createProviderOptions({
                      gateway: {
                        byok: {
                          openai: [],
                        },
                      },
                    }),
                    steeringInput: steering,
                  })

                  endState = { outcome: { status: 'unknown' } }
                  responseMessage = undefined
                  const signal = joinSignals(
                    step.abortSignal,
                    abortController.signal,
                    sliceAbortController.signal
                  )
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
                          timestamp:
                            result.response.timestamp.toISOString(),
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

                  for await (const chunk of stream) {
                    if (
                      chunk.type === 'abort' &&
                      sliceAbortController.signal.aborted &&
                      !abortController.signal.aborted &&
                      !step.abortSignal.aborted
                    ) {
                      continue
                    }
                    await publishFrame(chunk)
                  }

                  if (
                    !sliceAbortController.signal.aborted ||
                    abortController.signal.aborted ||
                    step.abortSignal.aborted
                  ) {
                    break
                  }

                  const accepted = interruptions.splice(
                    0,
                    interruptions.length
                  )
                  completedAssistantParts = [
                    ...completedAssistantParts,
                    ...completedPartsBeforeInterruptedStep(
                      responseMessage
                    ),
                  ]
                  await publishFrame({ type: 'reset-step' })
                  sliceMessages = [
                    ...messages,
                    ...(completedAssistantParts.length > 0
                      ? [
                          {
                            id: `${run.assistantMessageId}-context`,
                            role: 'assistant' as const,
                            parts: completedAssistantParts,
                          },
                        ]
                      : []),
                    ...accepted.map(withOriginAttribution),
                  ]
                }

                acceptingInterrupts = false
                const completedResponse = responseMessage as
                  | UIMessage
                  | undefined
                if (
                  completedResponse &&
                  completedAssistantParts.length > 0
                ) {
                  responseMessage = {
                    ...completedResponse,
                    parts: [
                      ...completedAssistantParts,
                      ...completedResponse.parts,
                    ],
                  }
                }

                let status:
                  | 'cancelled'
                  | 'completed'
                  | 'failed'
                  | 'interrupted'
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
                    status === 'completed'
                      ? endState.finishReason
                      : undefined,
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
                step.broadcast('frame', {
                  runId: run.id,
                  seq: sequence,
                  chunk,
                })
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
                publishStatus(
                  status,
                  status === 'failed' ? failure : undefined
                )
              } finally {
                acceptingInterrupts = false
                const pendingSteering = steering.close()
                for (const pending of pendingSteering) {
                  await step.queue.send('runs', {
                    idempotencyId: pending.message.id,
                    model: command.model,
                    message: pending.message,
                  })
                }
                if (step.vars.activeRun?.runId === run.id) {
                  step.vars.activeRun = undefined
                }
              }
            },
          }),
      },
      {
        name: 'inbox',
        run: branch =>
          branch.loop(
            `active-inbox-${submission.runId}`,
            async inboxLoop => {
              const inboxMessage = await inboxLoop.queue.next(
                'next-active-inbox',
                { names: ['inbox'] }
              )
              await routeInboxMessage(inboxLoop, inboxMessage.body)
            }
          ),
      },
    ])
  })
}

export default workflow(runWorkflow)
