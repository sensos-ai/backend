import type { UIMessageChunk } from 'ai'
import { z } from 'zod'

export const runStreamCursorSchema = z.string().min(1)
export type RunStreamCursor = z.infer<typeof runStreamCursorSchema>

export const runStreamName = (runId: string) =>
  `sensos/runs/${encodeURIComponent(runId)}`

export type RunStreamChunk = {
  runId: string
  sequence: number
  chunk: UIMessageChunk
  cursor?: RunStreamCursor
}
