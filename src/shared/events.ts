import { createNanoEvents } from 'nanoevents'
import { appendFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export type LanguageModel = { provider: string; modelId: string }

interface AIEvents {
  start: (type: 'stream' | 'generate', model: LanguageModel) => void
}

export const aiEmitter = createNanoEvents<AIEvents>()

let removeLogListener: (() => void) | undefined
let logWrite = Promise.resolve()

/**
 * Sends model middleware events to a line-oriented log in the current project.
 * Safe to call repeatedly; only one listener is active at a time.
 */
export function startAIEventLogListener(
  logPath = process.env.SENSOS_AI_EVENT_LOG_PATH ??
    resolve(process.cwd(), 'log.txt')
) {
  removeLogListener?.()
  removeLogListener = aiEmitter.on('start', (type, model) => {
    const timestamp = new Date().toLocaleString('en-US', {
      dateStyle: 'medium',
      timeStyle: 'medium',
    })
    const line = `${timestamp} ${type} provider=${model.provider} model=${model.modelId}\n`

    // Preserve event order without allowing a logging failure to affect inference.
    logWrite = logWrite.then(
      () => appendFile(logPath, line),
      () => appendFile(logPath, line)
    )
  })
}

export function flushAIEventLog() {
  return logWrite.catch(() => undefined)
}
