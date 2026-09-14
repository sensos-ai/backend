import { expect, test } from 'bun:test'
import type { UIMessage } from 'ai'
import { scriptedUsage, textTurn } from '../../fixtures/llm/scenario'
import { startCliE2E } from '../../helpers/cli-e2e'
import { waitForValue } from '../../helpers/wait'

function messageText(message: UIMessage): string {
  return message.parts
    .filter(part => part.type === 'text' || part.type === 'reasoning')
    .map(part => part.text)
    .join('')
}

function heldTurn(prompt: string, gate: string, partial: string) {
  return {
    expect: { promptContains: prompt },
    chunks: [
      { type: 'reasoning-start' as const, id: 'reasoning-1' },
      {
        type: 'reasoning-delta' as const,
        id: 'reasoning-1',
        delta: 'working through it',
      },
      { type: 'reasoning-end' as const, id: 'reasoning-1' },
      { type: 'text-start' as const, id: 'text-1' },
      { type: 'text-delta' as const, id: 'text-1', delta: partial },
      { type: 'hold' as const, gate },
      { type: 'text-end' as const, id: 'text-1' },
      {
        type: 'finish' as const,
        finishReason: { unified: 'stop' as const, raw: 'stop' },
        usage: scriptedUsage,
      },
    ],
  }
}

test('/interrupt cancels the active provider request and completes a successor run', async () => {
  const cli = await startCliE2E('interrupt', {
    name: 'CLI interrupt',
    turns: [
      heldTurn(
        'begin interrupt journey',
        'first-run',
        'partial before interrupt'
      ),
      textTurn('successor completed', {
        expect: { promptContains: 'change direction now' },
      }),
    ],
  })
  const connection = cli
    .connect()
    .connect({ clientId: 'interrupt-observer' })
  try {
    await cli.sendLine('begin interrupt journey')
    await cli.gateway.waitForRequest(1, 20_000)
    const active = await waitForValue(
      () => connection.getSession(),
      snapshot => Boolean(snapshot.activeRunId),
      { description: 'interrupt run to become active', timeoutMs: 20_000 }
    )
    const interruptedRunId = active.activeRunId
    if (!interruptedRunId) throw new Error('Missing active interrupt run')

    await cli.sendLine('/interrupt change direction now')
    await Promise.all([
      cli.gateway.waitForAbort(1, 20_000),
      cli.gateway.waitForRequest(2, 20_000),
    ])
    await waitForValue(
      () => connection.getRun(interruptedRunId),
      run => run?.status === 'interrupted',
      { description: 'original run to be interrupted', timeoutMs: 20_000 }
    )
    const completed = await waitForValue(
      () => connection.getSession(),
      snapshot =>
        snapshot.runStatus === 'completed' &&
        snapshot.messages.some(
          (message: UIMessage) =>
            messageText(message) === 'successor completed'
        ),
      { description: 'interrupt successor to complete', timeoutMs: 20_000 }
    )
    const texts = completed.messages.map(messageText)
    expect(
      texts.filter((text: string) =>
        text.includes('partial before interrupt')
      )
    ).toHaveLength(1)
    expect(texts.indexOf('change direction now')).toBeGreaterThan(
      texts.findIndex((text: string) =>
        text.includes('partial before interrupt')
      )
    )
    expect(texts).toContain('successor completed')
    await cli.sendControlC()
    expect(await cli.waitForExit()).toBe(0)
    cli.gateway.assertConsumed()
  } finally {
    await connection.dispose()
    await cli.stop()
  }
}, 60_000)

test('/queue defers one message until the active run completes', async () => {
  const cli = await startCliE2E('queue', {
    name: 'CLI queue',
    turns: [
      heldTurn('begin queue journey', 'active-run', 'active response'),
      textTurn('queued response', {
        expect: { promptContains: 'run exactly once later' },
      }),
    ],
  })
  const connection = cli.connect().connect({ clientId: 'queue-observer' })
  try {
    await cli.sendLine('begin queue journey')
    await cli.gateway.waitForRequest(1, 20_000)
    await cli.sendLine('/queue run exactly once later')
    await Bun.sleep(250)
    expect(cli.gateway.requests).toHaveLength(1)
    expect(
      (await connection.getSession()).messages.map(messageText)
    ).not.toContain('run exactly once later')

    cli.gateway.release('active-run')
    await cli.gateway.waitForRequest(2, 20_000)
    const completed = await waitForValue(
      () => connection.getSession(),
      snapshot =>
        snapshot.runStatus === 'completed' &&
        snapshot.messages.some(
          (message: UIMessage) =>
            messageText(message) === 'queued response'
        ),
      { description: 'queued run to complete', timeoutMs: 20_000 }
    )
    expect(
      completed.messages.filter(
        (message: UIMessage) =>
          messageText(message) === 'run exactly once later'
      )
    ).toHaveLength(1)
    expect(cli.gateway.requests).toHaveLength(2)
    await cli.sendControlC()
    expect(await cli.waitForExit()).toBe(0)
    cli.gateway.assertConsumed()
  } finally {
    await connection.dispose()
    await cli.stop()
  }
}, 60_000)

test('/stop cancels without a successor and leaves the composer usable', async () => {
  const cli = await startCliE2E('stop', {
    name: 'CLI stop',
    turns: [
      heldTurn('begin stop journey', 'stopped-run', 'partial before stop'),
      textTurn('ordinary prompt completed', {
        expect: { promptContains: 'continue after stop' },
      }),
    ],
  })
  const connection = cli.connect().connect({ clientId: 'stop-observer' })
  try {
    await cli.sendLine('begin stop journey')
    await cli.gateway.waitForRequest(1, 20_000)
    const active = await waitForValue(
      () => connection.getSession(),
      snapshot => Boolean(snapshot.activeRunId),
      { description: 'stop run to become active', timeoutMs: 20_000 }
    )
    const cancelledRunId = active.activeRunId
    if (!cancelledRunId) throw new Error('Missing active stop run')
    await cli.sendLine('/stop')
    await cli.gateway.waitForAbort(1, 20_000)
    await waitForValue(
      () => connection.getRun(cancelledRunId),
      run => run?.status === 'cancelled',
      { description: 'stopped run to be cancelled', timeoutMs: 20_000 }
    )
    expect(cli.gateway.requests).toHaveLength(1)
    const stopped = await connection.getSession()
    expect(
      stopped.messages.filter((message: UIMessage) =>
        messageText(message).includes('partial before stop')
      )
    ).toHaveLength(1)

    await cli.sendLine('continue after stop')
    await cli.gateway.waitForRequest(2, 20_000)
    await waitForValue(
      () => connection.getSession(),
      snapshot =>
        snapshot.runStatus === 'completed' &&
        snapshot.messages.some(
          (message: UIMessage) =>
            messageText(message) === 'ordinary prompt completed'
        ),
      {
        description: 'ordinary prompt after stop to complete',
        timeoutMs: 20_000,
      }
    )
    await cli.sendControlC()
    expect(await cli.waitForExit()).toBe(0)
    cli.gateway.assertConsumed()
  } finally {
    await connection.dispose()
    await cli.stop()
  }
}, 60_000)
