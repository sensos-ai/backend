import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { UIMessageChunk } from 'ai'
import {
  TerminalRenderer,
  type TerminalInput,
  type TerminalOutput,
} from '@/chat/tui/tui/terminal-renderer'

class FakeInput extends EventEmitter implements TerminalInput {
  isTTY = true

  resume() {
    return this
  }

  pause() {
    return this
  }

  setRawMode() {
    return this
  }
}

class FakeOutput extends EventEmitter implements TerminalOutput {
  columns = 100
  rows = 30
  chunks: string[] = []

  write(chunk: string | Uint8Array) {
    this.chunks.push(chunk.toString())
    return true
  }
}

function pendingStream() {
  let controller:
    | ReadableStreamDefaultController<UIMessageChunk>
    | undefined
  return {
    stream: new ReadableStream<UIMessageChunk>({
      start(value) {
        controller = value
      },
    }),
    close() {
      controller?.close()
    },
    abort() {
      controller?.enqueue({ type: 'abort', reason: 'cancelled' })
      controller?.close()
    },
  }
}

const commands = [
  {
    name: '/switch-session' as const,
    description: 'Switch to another session',
    run: () => 'switch-session' as const,
  },
  {
    name: '/model' as const,
    description: 'Choose the model',
    run: () => 'continue' as const,
  },
]

describe('TerminalRenderer slash command completion', () => {
  test('shows only the connection status in the input bar', async () => {
    const input = new FakeInput()
    const output = new FakeOutput()
    const renderer = new TerminalRenderer({ input, output })
    const prompt = renderer.readPrompt()

    await Promise.resolve()
    renderer.setAgentConnectionStatus('ready')
    expect(output.chunks.join('')).toContain('┌ \x1b[92m● Ready\x1b[0m ')

    input.emit('data', Buffer.from('\x03'))
    await expect(prompt).rejects.toThrow('Interrupted')
  })

  test('renders a ghost suffix and accepts it with Tab', async () => {
    const input = new FakeInput()
    const output = new FakeOutput()
    const renderer = new TerminalRenderer({ input, output })
    const prompt = renderer.readPrompt({ commands })

    await Promise.resolve()
    input.emit('data', Buffer.from('/sw'))
    expect(output.chunks.join('')).toContain(
      '/sw█\x1b[2mitch-session\x1b[0m'
    )

    input.emit('data', Buffer.from('\t'))
    input.emit('data', Buffer.from('\r'))

    await expect(prompt).resolves.toBe('/switch-session')
  })

  test('highlights and completes the selected command', async () => {
    const input = new FakeInput()
    const output = new FakeOutput()
    const renderer = new TerminalRenderer({ input, output })
    const prompt = renderer.readPrompt({ commands })

    await Promise.resolve()
    input.emit('data', Buffer.from('/'))
    expect(output.chunks.join('')).toContain(
      '\x1b[95m /switch-session  Switch to another session'
    )
    expect(output.chunks.join('')).toContain(
      '\x1b[2m /model           Choose the model'
    )

    input.emit('data', Buffer.from('\x1B[B'))
    expect(output.chunks.join('')).toContain(
      '\x1b[95m /model           Choose the model'
    )

    input.emit('data', Buffer.from('\t'))
    input.emit('data', Buffer.from('\r'))

    await expect(prompt).resolves.toBe('/model')
  })

  test('shows argument hints beside command names without repeating usage', async () => {
    const input = new FakeInput()
    const output = new FakeOutput()
    const renderer = new TerminalRenderer({ input, output })
    const prompt = renderer.readPrompt({
      commands: [
        {
          name: '/interrupt',
          argumentHint: '<message>',
          description: 'Steer the active run with a new message',
          run: () => undefined,
        },
        {
          name: '/queue',
          argumentHint: '<message>',
          description: 'Queue a message for the next turn',
          run: () => undefined,
        },
      ],
    })

    await Promise.resolve()
    input.emit('data', Buffer.from('/'))
    const frame = output.chunks.join('')
    expect(frame).toContain(
      '/interrupt <message>  Steer the active run with a new message'
    )
    expect(frame).toContain(
      '/queue <message>      Queue a message for the next turn'
    )
    expect(frame).not.toContain(
      'Steer the active run with a new message: /interrupt <message>'
    )

    input.emit('data', Buffer.from('\x03'))
    await expect(prompt).rejects.toThrow('Interrupted')
  })
})

describe('TerminalRenderer stream controls', () => {
  test('/switch-session detaches locally without cancelling the run', async () => {
    const input = new FakeInput()
    const output = new FakeOutput()
    const source = pendingStream()
    let detached = false
    let aborted = false
    const deliveries: string[] = []
    const renderer = new TerminalRenderer({ input, output })
    const rendered = renderer.renderStream(
      {
        uiMessageStream: source.stream,
        detach() {
          detached = true
          source.close()
        },
        abort() {
          aborted = true
        },
      },
      {
        continueSession: true,
        waitForExit: false,
        detachOnInterrupt: true,
        commands,
        onSubmitDuringStream: async prompt => {
          deliveries.push(prompt)
        },
      }
    )

    await Promise.resolve()
    input.emit('data', Buffer.from('/sw'))
    input.emit('data', Buffer.from('\t'))
    input.emit('data', Buffer.from('\r'))

    await expect(rendered).rejects.toMatchObject({
      name: 'SwitchSessionError',
    })
    await rendered.catch(() => undefined)
    expect(detached).toBe(true)
    expect(aborted).toBe(false)
    expect(deliveries).toEqual([])
  })

  test('streaming Ctrl-C cancels the run and returns control', async () => {
    const input = new FakeInput()
    const output = new FakeOutput()
    const source = pendingStream()
    let aborted = 0
    const renderer = new TerminalRenderer({ input, output })
    const rendered = renderer.renderStream(
      {
        uiMessageStream: source.stream,
        abort() {
          aborted += 1
          source.abort()
        },
      },
      {
        continueSession: true,
        waitForExit: false,
        onSubmitDuringStream: async () => {},
      }
    )

    await Promise.resolve()
    input.emit('data', Buffer.from('\x03'))

    await expect(rendered).rejects.toThrow('Interrupted')
    expect(aborted).toBe(1)
  })

  test('/stop invokes explicit cancellation and sends no message', async () => {
    const input = new FakeInput()
    const output = new FakeOutput()
    const source = pendingStream()
    let stopped = 0
    const deliveries: string[] = []
    const renderer = new TerminalRenderer({ input, output })
    const rendered = renderer.renderStream(
      { uiMessageStream: source.stream },
      {
        continueSession: true,
        waitForExit: false,
        onSubmitDuringStream: async prompt => {
          deliveries.push(prompt)
        },
        onStopDuringStream: async () => {
          stopped += 1
          source.close()
        },
      }
    )

    await Promise.resolve()
    input.emit('data', Buffer.from('/stop'))
    input.emit('data', Buffer.from('\r'))

    await rendered
    expect(stopped).toBe(1)
    expect(deliveries).toEqual([])
  })
})
