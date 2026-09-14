import { expect, test } from 'bun:test'
import type { UIMessage } from 'ai'
import { type CliE2E, startCliE2E } from '../../helpers/cli-e2e'
import { waitForValue } from '../../helpers/wait'

function messageText(message: UIMessage): string {
  return message.parts
    .filter(part => part.type === 'text' || part.type === 'reasoning')
    .map(part => part.text)
    .join('')
}

async function activeRunId(cli: Awaited<ReturnType<typeof startCliE2E>>) {
  const connection = cli.connect().connect({
    clientId: `failure-observer-${crypto.randomUUID()}`,
  })
  const snapshot = await waitForValue(
    () => connection.getSession(),
    value => Boolean(value.activeRunId),
    { description: 'failed run to become active', timeoutMs: 20_000 }
  )
  if (!snapshot.activeRunId) throw new Error('Missing active run')
  return { connection, runId: snapshot.activeRunId }
}

type ObserverConnection = ReturnType<
  ReturnType<CliE2E['connect']>['connect']
>

test('provider error after emitted chunks preserves output and fails without cancellation', async () => {
  const cli = await startCliE2E('provider-error', {
    name: 'provider error after chunks',
    turns: [
      {
        expect: { promptContains: 'trigger provider error' },
        chunks: [
          { type: 'text-start', id: 'text-1' },
          {
            type: 'text-delta',
            id: 'text-1',
            delta: 'useful output before provider failure',
          },
          { type: 'hold', gate: 'fail-provider' },
          {
            type: 'throw',
            message: 'scripted provider connection failed',
          },
        ],
      },
    ],
  })
  let connection: ObserverConnection | undefined
  try {
    await cli.sendLine('trigger provider error')
    await cli.gateway.waitForRequest(1, 20_000)
    const active = await activeRunId(cli)
    connection = active.connection
    const observer = active.connection
    cli.gateway.release('fail-provider')
    const run = await waitForValue(
      () => observer.getRun(active.runId),
      value => value?.status === 'failed',
      { description: 'provider-error run to fail', timeoutMs: 20_000 }
    )
    expect(run?.error).toContain('Failed to process successful response')
    expect(cli.gateway.aborts).toHaveLength(0)
    await cli.waitForScreen('successful')
    await cli.waitForScreen('response')
    const snapshot = await observer.getSession()
    expect(snapshot.runStatus).toBe('failed')
    expect(snapshot.messages.map(messageText)).toContain(
      'useful output before provider failure'
    )
    await cli.sendControlC()
    expect(await cli.waitForExit()).toBe(0)
    cli.gateway.assertConsumed()
  } finally {
    await connection?.dispose()
    await cli.stop()
  }
}, 60_000)

test('stream ending without a finish chunk is an actionable failure, not an abort', async () => {
  const cli = await startCliE2E('malformed-stream', {
    name: 'malformed stream termination',
    turns: [
      {
        expect: { promptContains: 'trigger malformed stream' },
        chunks: [
          { type: 'text-start', id: 'text-1' },
          {
            type: 'text-delta',
            id: 'text-1',
            delta: 'output before malformed termination',
          },
          { type: 'hold', gate: 'end-malformed' },
          { type: 'malformed', data: '{not-json' },
        ],
      },
    ],
  })
  let connection: ObserverConnection | undefined
  try {
    await cli.sendLine('trigger malformed stream')
    await cli.gateway.waitForRequest(1, 20_000)
    const active = await activeRunId(cli)
    connection = active.connection
    const observer = active.connection
    cli.gateway.release('end-malformed')
    const run = await waitForValue(
      () => observer.getRun(active.runId),
      value => value?.status === 'failed',
      { description: 'malformed stream to fail', timeoutMs: 20_000 }
    )
    expect(run?.error).toContain('JSON parsing failed')
    expect(cli.gateway.aborts).toHaveLength(0)
    await cli.waitForScreen("Expected '}'")
    const snapshot = await observer.getSession()
    expect(snapshot.runStatus).toBe('failed')
    expect(snapshot.messages.map(messageText)).toContain(
      'output before malformed termination'
    )
    await cli.sendControlC()
    expect(await cli.waitForExit()).toBe(0)
    cli.gateway.assertConsumed()
  } finally {
    await connection?.dispose()
    await cli.stop()
  }
}, 60_000)
