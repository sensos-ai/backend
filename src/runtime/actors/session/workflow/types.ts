import type {
  FinishReason,
  LanguageModelUsage,
  UIMessage,
  UIMessageChunk,
  UIMessageStreamOutcome,
} from 'ai'
import type { RunCommand, RunCompletion } from '../config'
import type { RunStatus, RunStepMetadata } from '../db'
import type { RunWorkflow } from '../types'

export type SessionWorkflowContext = Parameters<RunWorkflow>[0]
export type AcceptedWork = {
  command: RunCommand
  submission: RunCompletion
}
export type NextWork = (AcceptedWork & { kind: 'run' }) | { kind: 'inbox' }
export type ExecuteRunInput = { command: RunCommand; runId: string }
export type ConsumedRunStream = {
  responseMessage?: UIMessage
  streamedResponseMessage?: UIMessage
  outcome: UIMessageStreamOutcome
  finishReason?: FinishReason
  steps: RunStepMetadata[]
  totalUsage: LanguageModelUsage
}
export type TerminalRunOutcome = {
  status: Extract<
    RunStatus,
    'cancelled' | 'completed' | 'failed' | 'interrupted'
  >
  chunk: UIMessageChunk
  error?: string
  finishReason?: FinishReason
}
