import { expect, test } from 'bun:test'
import type { UIMessage } from 'ai'
import type { DeliveryRoutedEvent } from '@/runtime/actors/session/config'
import { scriptedUsage, textTurn } from '../../fixtures/llm/scenario'
import { startCliE2E } from '../../helpers/cli-e2e'
import { waitForEvent, waitForValue } from '../../helpers/wait'

function messageText(message: UIMessage): string {
  return message.parts
    .filter(part => part.type === 'text' || part.type === 'reasoning')
    .map(part => part.text)
    .join('')
}

test('an unexpectedly disconnected CLI resumes completed active and queued work once', async () => {
  const cli = await startCliE2E('disconnect-resume', {
    name: 'CLI disconnect and resume',
    turns: [
      {
        expect: { promptContains: 'keep working while I reconnect' },
        chunks: [
          { type: 'text-start', id: 'text-1' },
          {
            type: 'text-delta',
            id: 'text-1',
            delta: 'partial before disconnect',
          },
          { type: 'hold', gate: 'disconnected-client' },
          {
            type: 'text-delta',
            id: 'text-1',
            delta: ' and completed after resume',
          },
          { type: 'text-end', id: 'text-1' },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: scriptedUsage,
          },
        ],
      },
      textTurn('queued work completed once', {
        expect: { promptContains: 'run once after reconnect' },
      }),
    ],
  })
  const connection = cli
    .connect()
    .connect({ clientId: 'disconnect-resume-observer' })
  try {
    await cli.sendLine('keep working while I reconnect')
    await cli.gateway.waitForRequest(1, 20_000)
    const queued = waitForEvent<DeliveryRoutedEvent>(
      listener => connection.on('deliveryRouted', listener),
      event => event.status === 'queued',
      { description: 'successor delivery to be durably queued' }
    )
    await cli.sendLine('/queue run once after reconnect')
    await queued
    expect(cli.gateway.requests).toHaveLength(1)

    await cli.disconnect()
    expect(cli.gateway.aborts).toHaveLength(0)
    expect((await fetch(`${cli.endpoint}/health`)).ok).toBe(true)
    await cli.resume()
    cli.gateway.release('disconnected-client')
    await cli.gateway.waitForRequest(2, 40_000)
    const completed = await waitForValue(
      () => connection.getSession(),
      snapshot =>
        snapshot.runStatus === 'completed' &&
        snapshot.messages.some(
          (message: UIMessage) =>
            messageText(message) === 'queued work completed once'
        ),
      {
        description: 'resumed stream and queued successor to complete',
        timeoutMs: 20_000,
      }
    )
    const resumedScreen = await waitForValue(
      () => cli.screen().split('--- resumed CLI ---').at(-1) ?? '',
      screen => screen.includes('after resume') && screen.includes('once'),
      {
        description: 'resumed terminal to render durable run output',
        timeoutMs: 15_000,
      }
    )
    expect(resumedScreen).toContain('after resume')
    expect(cli.gateway.aborts).toHaveLength(0)
    expect(cli.gateway.requests).toHaveLength(2)
    expect(
      completed.messages.filter(
        (message: UIMessage) =>
          messageText(message) ===
          'partial before disconnect and completed after resume'
      )
    ).toHaveLength(1)
    expect(
      completed.messages.filter(
        (message: UIMessage) =>
          messageText(message) === 'run once after reconnect'
      )
    ).toHaveLength(1)
    expect(
      completed.messages.filter(
        (message: UIMessage) =>
          messageText(message) === 'queued work completed once'
      )
    ).toHaveLength(1)

    await cli.sendControlC()
    expect(await cli.waitForExit()).toBe(0)
    cli.gateway.assertConsumed()
  } finally {
    await connection.dispose()
    await cli.stop()
  }
}, 60_000)

test('/switch-session leaves the original stream running and reattaches to its transcript', async () => {
  const cli = await startCliE2E('switch-session', {
    name: 'CLI session switching',
    turns: [
      {
        expect: { promptContains: 'keep working while I switch' },
        chunks: [
          { type: 'text-start', id: 'text-1' },
          {
            type: 'text-delta',
            id: 'text-1',
            delta: 'partial before switch',
          },
          { type: 'hold', gate: 'switched-session' },
          {
            type: 'text-delta',
            id: 'text-1',
            delta: ' and completed while away',
          },
          { type: 'text-end', id: 'text-1' },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: scriptedUsage,
          },
        ],
      },
      textTurn('switched queue completed once', {
        expect: { promptContains: 'run once while away' },
      }),
    ],
  })
  const connection = cli
    .connect()
    .connect({ clientId: 'switch-session-observer' })
  try {
    await cli.reserveSession('Switch target')
    await cli.sendLine('keep working while I switch')
    await cli.gateway.waitForRequest(1, 20_000)
    const queued = waitForEvent<DeliveryRoutedEvent>(
      listener => connection.on('deliveryRouted', listener),
      event => event.status === 'queued',
      { description: 'switched successor delivery to be durably queued' }
    )
    await cli.sendLine('/queue run once while away')
    await queued
    await cli.sendLine('/switch-session')
    await cli.waitForScreen('Select a session', 20_000)
    await cli.sendDown()
    await cli.sendLine('')
    await cli.waitForScreen('✔ Select a session Switch target', 20_000)

    expect(cli.gateway.aborts).toHaveLength(0)
    cli.gateway.release('switched-session')
    await cli.gateway.waitForRequest(2, 20_000)
    const completed = await waitForValue(
      () => connection.getSession(),
      snapshot =>
        snapshot.runStatus === 'completed' &&
        snapshot.messages.some(
          (message: UIMessage) =>
            messageText(message) === 'switched queue completed once'
        ),
      {
        description:
          'original and queued runs to finish while switched away',
        timeoutMs: 20_000,
      }
    )

    const secondPickerStart = cli.screen().length
    await cli.sendLine('/switch-session')
    await waitForValue(
      cli.screen,
      screen =>
        screen.slice(secondPickerStart).includes('? Select a session'),
      {
        description: 'second session picker',
        timeoutMs: 20_000,
      }
    )
    await cli.sendDown()
    await cli.sendLine('')
    await waitForValue(
      cli.screen,
      screen =>
        screen
          .slice(secondPickerStart)
          .includes('✔ Select a session E2E switch-session'),
      {
        description: 'original session selection',
        timeoutMs: 20_000,
      }
    )
    await waitForValue(
      cli.screen,
      screen => {
        const selected = screen.lastIndexOf(
          '✔ Select a session E2E switch-session'
        )
        return (
          selected >= 0 &&
          screen.slice(selected).includes('completed') &&
          screen.slice(selected).includes('while away')
        )
      },
      {
        description: 'original transcript after switching back',
        timeoutMs: 20_000,
      }
    )

    expect(cli.gateway.aborts).toHaveLength(0)
    expect(cli.gateway.requests).toHaveLength(2)
    expect(
      completed.messages.filter(
        (message: UIMessage) =>
          messageText(message) ===
          'partial before switch and completed while away'
      )
    ).toHaveLength(1)
    expect(
      completed.messages.filter(
        (message: UIMessage) =>
          messageText(message) === 'run once while away'
      )
    ).toHaveLength(1)
    expect(
      completed.messages.filter(
        (message: UIMessage) =>
          messageText(message) === 'switched queue completed once'
      )
    ).toHaveLength(1)

    await cli.sendControlC()
    expect(await cli.waitForExit()).toBe(0)
    cli.gateway.assertConsumed()
  } finally {
    await connection.dispose()
    await cli.stop()
  }
}, 60_000)
