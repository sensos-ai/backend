import { joinSignals } from 'rivetkit/utils'
import {
  createAgentUIStream,
  type FinishReason,
  type UIMessage,
  type UIMessageChunk,
  type UIMessageStreamOutcome,
  readUIMessageStream,
} from 'ai'
import { createAgentOsSandbox } from '@/chat/agentos-sandbox'
import {
  createHarness,
  createRunSteeringInput,
  type SteeringMessage,
} from '@/chat/harness'
import { createIdGeneratorWithPrefix, errorMessage } from '@/shared/utils'
import {
  appendRunFrame,
  finalizeRun,
  getRun,
  listMessages,
  setSessionTitle,
  type RunStepMetadata,
  updateRun,
} from '../../db'
import { toChatStatus } from '../../config'
import { generateSessionTitle, userMessageText } from '../../title'
import {
  cutoffAssistantMessage,
  hasAssistantContent,
} from '../../utils/messages'
import { aggregateUsage } from '../../utils/usage'
import type { ExecuteRunInput, SessionWorkflowContext } from '../types'
import type { TerminalRunOutcome } from '../types'
import {
  releaseRuntimeActivity,
  runtimeActivityKey,
} from '@/runtime/activity'
import {
  appendRunStreamChunk,
  closeRunStream,
} from '@/runtime/durable-run-stream'
import { recordTiming } from '@/shared/timing'

const terminalStatuses = new Set([
  'cancelled',
  'completed',
  'failed',
  'interrupted',
])
const createMessageId = createIdGeneratorWithPrefix('msg')

export function resolveRunOutcome(input: {
  outcome: UIMessageStreamOutcome
  finishReason?: FinishReason
  cancelled: boolean
  interrupted: boolean
  workflowAborted: boolean
}): TerminalRunOutcome {
  if (input.cancelled) {
    return {
      status: 'cancelled',
      chunk: { type: 'abort', reason: 'cancelled' },
    }
  }
  if (
    input.interrupted ||
    input.workflowAborted ||
    input.outcome.status === 'aborted'
  ) {
    return {
      status: 'interrupted',
      chunk: { type: 'abort', reason: 'interrupted' },
    }
  }
  if (input.outcome.status === 'completed') {
    return {
      status: 'completed',
      chunk: { type: 'finish', finishReason: input.finishReason },
      finishReason: input.finishReason,
    }
  }
  const error =
    input.outcome.status === 'failed'
      ? errorMessage(input.outcome.error ?? 'Agent stream failed')
      : 'Agent stream ended without a terminal outcome'
  return {
    status: 'failed',
    chunk: { type: 'error', errorText: error },
    error,
  }
}

export async function executeRun(
  context: SessionWorkflowContext,
  input: ExecuteRunInput
): Promise<void> {
  const activityKey = runtimeActivityKey(input.command.idempotencyId)
  await context.step({
    name: 'execute-run',
    timeout: 0,
    maxRetries: 0,
    run: async step => {
      const executionStartedAt = Date.now()
      const run = await getRun(step.db, input.runId)
      if (!run || terminalStatuses.has(run.status)) {
        releaseRuntimeActivity(activityKey)
        return
      }

      let sequence = 0
      const publishFrame = async (chunk: UIMessageChunk) => {
        const firstFrame = sequence === 0
        const frameSequence = sequence
        await appendRunFrame(step.db, run.id, frameSequence, chunk)
        sequence += 1
        await appendRunStreamChunk(run.id, frameSequence, chunk)
        if (firstFrame) {
          recordTiming('actor.run.first_frame', {
            sessionId: step.state.sessionId,
            runId: run.id,
            elapsedMs: Date.now() - executionStartedAt,
          })
        }
        step.broadcast('frame', {
          runId: run.id,
          seq: frameSequence,
          chunk,
        })
      }
      const closeOutput = async (chunk: UIMessageChunk) => {
        try {
          await closeRunStream(run.id, chunk)
        } catch (error) {
          step.log.warn({
            msg: 'durable run stream close failed',
            runId: run.id,
            error: error instanceof Error ? error.message : String(error),
          })
        }
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
        await closeOutput(chunk)
        step.broadcast('frame', {
          runId: run.id,
          seq: sequence,
          chunk,
        })
        publishStatus('cancelled')
        const messages = await listMessages(step.db)
        step.broadcast('messagesChanged', {
          messages,
          revision: finalized.revision,
        })
        releaseRuntimeActivity(activityKey)
        return
      }

      const abortController = new AbortController()
      const interruptController = new AbortController()
      const steering = createRunSteeringInput()
      let acceptingInterrupts = true
      let interruptedBy: SteeringMessage | undefined
      step.vars.activeRun = {
        runId: run.id,
        abortController,
        steering,
        interrupt: message => {
          if (interruptedBy?.message.id === message.message.id) {
            return true
          }
          if (!acceptingInterrupts || interruptedBy) return false
          acceptingInterrupts = false
          interruptedBy = message
          interruptController.abort('interrupted')
          return true
        },
      }

      let responseMessage: UIMessage | undefined
      let streamedResponseMessage: UIMessage | undefined

      const generateMissingTitle = async () => {
        const prompt = userMessageText(input.command.message)
        if (!prompt || step.state.title) return

        try {
          const title = await generateSessionTitle(prompt, {
            features: step.state.config.features,
            provider: input.command.model?.provider,
          })
          if (!title || step.state.title) return

          step.state.title = title
          await setSessionTitle(step.db, step.state.title)
          step.broadcast('titleChanged', { title: step.state.title })
        } catch (error) {
          step.log.warn({
            msg: 'session title generation failed',
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }

      async function consumeRunStream() {
        const messages = await listMessages(step.db)
        const sandbox = createAgentOsSandbox({
          id: step.actorId,
          vm: step.vars.vm,
          cwd: step.state.config.guestCwd,
        })
        const stepMetadata: RunStepMetadata[] = []
        const endState: {
          outcome: UIMessageStreamOutcome
          finishReason?: FinishReason
        } = { outcome: { status: 'unknown' } }
        const harness = await createHarness({
          sandbox,
          signal: abortController.signal,
          initialMessages: messages,
          model: input.command.model,
          features: step.state.config.features,
          instructions: step.state.config.instructions,
          providerOptions: {
            gateway: { byok: { openai: [] } },
          },
          steeringInput: steering,
        })
        const signal = joinSignals(
          step.abortSignal,
          abortController.signal,
          interruptController.signal
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
        let messageStreamController:
          | ReadableStreamDefaultController<UIMessageChunk>
          | undefined
        const messageSnapshots = readUIMessageStream({
          stream: new ReadableStream<UIMessageChunk>({
            start(controller) {
              messageStreamController = controller
            },
          }),
        })
        const consumeMessageSnapshots = (async () => {
          for await (const snapshot of messageSnapshots) {
            streamedResponseMessage = snapshot
          }
        })()
        try {
          for await (const chunk of stream) {
            messageStreamController?.enqueue(chunk)
            if (chunk.type !== 'abort') await publishFrame(chunk)
          }
        } finally {
          messageStreamController?.close()
          await consumeMessageSnapshots
        }
        if (hasAssistantContent(streamedResponseMessage)) {
          responseMessage = streamedResponseMessage
        }
        return { responseMessage, stepMetadata, endState }
      }

      try {
        recordTiming('actor.run.execution_start', {
          sessionId: step.state.sessionId,
          runId: run.id,
        })
        await updateRun(step.db, run.id, {
          status: 'running',
          error: null,
          startedAt: run.startedAt ?? new Date(),
        })
        publishStatus('running')

        const [{ responseMessage, stepMetadata, endState }] =
          await Promise.all([consumeRunStream(), generateMissingTitle()])

        acceptingInterrupts = false

        const terminal = resolveRunOutcome({
          outcome: endState.outcome,
          finishReason: endState.finishReason,
          cancelled: abortController.signal.aborted,
          interrupted: interruptedBy !== undefined,
          workflowAborted: step.abortSignal.aborted,
        })
        const { status, chunk: terminalChunk, error: failure } = terminal

        const finalized = await finalizeRun(step.db, run.id, {
          status,
          sequence,
          chunk: terminalChunk,
          responseMessage:
            status === 'completed'
              ? responseMessage
              : status === 'interrupted' || status === 'cancelled'
                ? cutoffAssistantMessage(
                    run.assistantMessageId,
                    responseMessage,
                    status === 'cancelled' ? '[Stopped]' : '[Interrupted]'
                  )
                : hasAssistantContent(responseMessage)
                  ? responseMessage
                  : undefined,
          error: failure,
          finishReason:
            status === 'completed' ? terminal.finishReason : undefined,
          steps: stepMetadata,
          totalUsage: aggregateUsage(stepMetadata),
          responseMetadata: stepMetadata.at(-1)?.response,
        })

        await closeOutput(terminalChunk)

        // finalizeRun commits the assistant message and terminal frame in one
        // transaction. Only publish the finish after that transaction lands.
        step.broadcast('frame', {
          runId: run.id,
          seq: sequence,
          chunk: terminalChunk,
        })
        if (status !== 'failed' || hasAssistantContent(responseMessage)) {
          const messages = await listMessages(step.db)
          step.broadcast('messagesChanged', {
            messages,
            revision: finalized.revision,
          })
        }
        publishStatus(status, failure)
        recordTiming('actor.run.finalized', {
          sessionId: step.state.sessionId,
          runId: run.id,
          status,
          elapsedMs: Date.now() - executionStartedAt,
        })
      } catch (error) {
        const failure = errorMessage(error)
        const status = abortController.signal.aborted
          ? 'cancelled'
          : interruptedBy || step.abortSignal.aborted
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
          responseMessage:
            status === 'interrupted' || status === 'cancelled'
              ? cutoffAssistantMessage(
                  run.assistantMessageId,
                  hasAssistantContent(streamedResponseMessage)
                    ? streamedResponseMessage
                    : responseMessage,
                  status === 'cancelled' ? '[Stopped]' : '[Interrupted]'
                )
              : hasAssistantContent(streamedResponseMessage)
                ? streamedResponseMessage
                : hasAssistantContent(responseMessage)
                  ? responseMessage
                  : undefined,
          error: status === 'failed' ? failure : undefined,
        })
        await closeOutput(chunk)
        step.broadcast('frame', {
          runId: run.id,
          seq: sequence,
          chunk,
        })
        const messages = await listMessages(step.db)
        step.broadcast('messagesChanged', {
          messages,
          revision: finalized.revision,
        })
        publishStatus(status, status === 'failed' ? failure : undefined)
      } finally {
        acceptingInterrupts = false
        const pendingSteering = steering.close()
        for (const pending of pendingSteering) {
          await step.queue.send('runs', {
            idempotencyId: pending.message.id,
            model: input.command.model,
            message: pending.message,
          })
        }
        if (step.vars.activeRun?.runId === run.id) {
          step.vars.activeRun = undefined
        }
        releaseRuntimeActivity(activityKey)
      }
    },
  })
}
