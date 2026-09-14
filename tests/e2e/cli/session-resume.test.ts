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

test.todo('a detached CLI resumes its active stream and runs queued work once', async () => {
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
    await Bun.sleep(100)
    await cli.sendLine('/queue run once after reconnect')
    await Bun.sleep(250)
    expect(cli.gateway.requests).toHaveLength(1)

    expect(await cli.detach()).toBe(0)
    expect(cli.gateway.aborts).toHaveLength(0)
    cli.gateway.release('disconnected-client')
    await cli.gateway.waitForRequest(2, 20_000)
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

    await cli.resume()
    await cli.waitForScreen('Agent ready', 20_000)

    const resumedScreen = cli.screen().split('--- resumed CLI ---').at(-1)
    expect(resumedScreen).toContain('partial before disconnect')
    expect(resumedScreen).toContain('and completed after resume')
    expect(cli.gateway.aborts).toHaveLength(0)
    expect(cli.gateway.requests).toHaveLength(2)
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

    await cli.sendLine('/exit')
    expect(await cli.waitForExit()).toBe(0)
    cli.gateway.assertConsumed()
  } finally {
    await connection.dispose()
    await cli.stop()
  }
}, 60_000)
