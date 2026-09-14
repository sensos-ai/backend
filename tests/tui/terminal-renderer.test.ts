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

  write() {
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

describe('TerminalRenderer stream controls', () => {
  test('/exit detaches locally and never delivers a message', async () => {
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
        onSubmitDuringStream: async prompt => {
          deliveries.push(prompt)
        },
      }
    )

    await Promise.resolve()
    input.emit('data', Buffer.from('/exit'))
    input.emit('data', Buffer.from('\r'))

    expect(rendered).rejects.toThrow('Interrupted')
    await rendered.catch(() => undefined)
    expect(detached).toBe(true)
    expect(aborted).toBe(false)
    expect(deliveries).toEqual([])
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
