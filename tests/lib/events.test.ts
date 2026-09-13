import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  aiEmitter,
  flushAIEventLog,
  startAIEventLogListener,
} from '@/shared/events'

let directory: string | undefined

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
  directory = undefined
  startAIEventLogListener()
})

describe('AI event log', () => {
  test('writes one line for each model middleware event', async () => {
    directory = await mkdtemp(join(tmpdir(), 'sensos-ai-events-'))
    const logPath = join(directory, 'log.txt')
    startAIEventLogListener(logPath)

    aiEmitter.emit('start', 'stream', {
      provider: 'codex',
      modelId: 'gpt-5.6-sol',
    })
    aiEmitter.emit('start', 'generate', {
      provider: 'gateway',
      modelId: 'openai/gpt-5.6-sol',
    })
    await flushAIEventLog()

    expect(await readFile(logPath, 'utf8')).toMatch(
      /^.+ stream provider=codex model=gpt-5\.6-sol\n.+ generate provider=gateway model=openai\/gpt-5\.6-sol\n$/
    )
  })
})
