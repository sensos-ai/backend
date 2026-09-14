import { actor } from 'rivetkit'
import type { UIMessage } from 'ai'
import { sessionDatabase } from '@/runtime/actors/session/db/database'
import { recoverOrphanedActiveRun } from '@/runtime/actors/session/recovery'
import {
  deleteSessionData,
  finalizeRun,
  getRun,
  getSessionMeta,
  listMessages,
  listRunFrames,
  requestRunCancellation,
  setSessionTitle,
  submitRun,
} from '@/runtime/actors/session/db/queries'

export const queryTestActor = actor({
  db: sessionDatabase,
  actions: {
    submit: (context, input: Parameters<typeof submitRun>[1]) =>
      submitRun(context.db, input),
    snapshot: async (context, runId: string) => ({
      meta: await getSessionMeta(context.db),
      messages: await listMessages(context.db),
      frames: await listRunFrames(context.db, runId),
    }),
    finish: (context, runId: string, assistantMessage: UIMessage) =>
      finalizeRun(context.db, runId, {
        status: 'completed',
        sequence: 0,
        chunk: { type: 'finish', finishReason: 'stop' },
        responseMessage: assistantMessage,
        finishReason: 'stop',
        steps: [
          {
            callId: 'call_1',
            stepNumber: 0,
            finishReason: 'stop',
            usage: {
              inputTokens: 10,
              inputTokenDetails: {
                noCacheTokens: 10,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
              },
              outputTokens: 5,
              outputTokenDetails: { textTokens: 5, reasoningTokens: 0 },
              totalTokens: 15,
            },
            response: {
              id: 'response_1',
              timestamp: '2026-09-12T00:00:00.000Z',
              modelId: 'gpt-5.6-sol-2026-09-01',
            },
          },
        ],
        totalUsage: {
          inputTokens: 10,
          inputTokenDetails: {
            noCacheTokens: 10,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
          outputTokens: 5,
          outputTokenDetails: { textTokens: 5, reasoningTokens: 0 },
          totalTokens: 15,
        },
        responseMetadata: {
          id: 'response_1',
          timestamp: '2026-09-12T00:00:00.000Z',
          modelId: 'gpt-5.6-sol-2026-09-01',
        },
      }),
    cancel: (context, runId: string) =>
      requestRunCancellation(context.db, runId),
    recover: async context => {
      const meta = await getSessionMeta(context.db)
      return recoverOrphanedActiveRun({
        database: context.db,
        activeRunId: meta.activeRunId,
      })
    },
    getRun: (context, runId: string) => getRun(context.db, runId),
    setTitle: (context, title: string) =>
      setSessionTitle(context.db, title),
    deleteData: context => deleteSessionData(context.db),
  },
})
