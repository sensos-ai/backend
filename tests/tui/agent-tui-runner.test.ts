import { describe, expect, test } from 'bun:test'
import type { ChatTransport, UIMessage } from 'ai'
import {
  AgentTUIRunner,
  type AgentTUIRenderer,
} from '@/chat/tui/agent-tui-runner'

const restoredMessages: UIMessage[] = [
  {
    id: 'msg_existing_user',
    role: 'user',
    parts: [{ type: 'text', text: 'earlier question' }],
  },
  {
    id: 'msg_existing_assistant',
    role: 'assistant',
    parts: [{ type: 'text', text: 'earlier answer' }],
  },
]

describe('AgentTUIRunner history hydration', () => {
  test('renders restored messages and includes them in the next submission', async () => {
    let renderedMessages: UIMessage[] | undefined
    let submittedMessages: UIMessage[] | undefined
    const prompts = ['new question', undefined]
    const renderer: AgentTUIRenderer = {
      renderMessages(messages) {
        renderedMessages = messages
      },
      async readPrompt() {
        return prompts.shift()
      },
      async renderStream() {
        return {
          id: 'msg_new_assistant',
          role: 'assistant',
          parts: [{ type: 'text', text: 'new answer' }],
        }
      },
    }
    const transport: ChatTransport<UIMessage> = {
      async sendMessages(options) {
        submittedMessages = options.messages
        return new ReadableStream()
      },
      async reconnectToStream() {
        return null
      },
    }

    await new AgentTUIRunner({
      chatId: 'chat_existing',
      initialMessages: restoredMessages,
      renderer,
      transport,
    }).run()

    expect(renderedMessages).toEqual(restoredMessages)
    expect(submittedMessages?.slice(0, 2)).toEqual(restoredMessages)
    expect(submittedMessages?.at(-1)).toMatchObject({
      role: 'user',
      parts: [{ type: 'text', text: 'new question' }],
    })
    expect(submittedMessages?.at(-1)?.id).toMatch(/^msg_/)
  })

  test('accepts input while actor hydration is pending and then reconciles history', async () => {
    let applyUpdate:
      | ((snapshot: {
          messages: UIMessage[]
          revision: number
          title?: string
        }) => void)
      | undefined
    let resolveHydration:
      | ((value: {
          messages: UIMessage[]
          revision: number
          title?: string
        }) => void)
      | undefined
    const hydration = new Promise<{
      messages: UIMessage[]
      revision: number
      title?: string
    }>(resolve => {
      resolveHydration = resolve
    })
    let resolvePrompt: ((value: string | undefined) => void) | undefined
    const prompt = new Promise<string | undefined>(resolve => {
      resolvePrompt = resolve
    })
    const renders: UIMessage[][] = []
    const statuses: string[] = []
    const renderer: AgentTUIRenderer = {
      renderMessages(messages) {
        renders.push(messages)
      },
      readPrompt() {
        return prompt
      },
      async renderStream() {
        return undefined
      },
      setAgentConnectionStatus(status) {
        statuses.push(status)
      },
    }
    const transport: ChatTransport<UIMessage> = {
      async sendMessages() {
        return new ReadableStream()
      },
      async reconnectToStream() {
        return null
      },
    }

    const running = new AgentTUIRunner({
      chatId: 'chat_existing',
      initialMessages: restoredMessages.slice(0, 1),
      hydration,
      hydrationUpdates: apply => {
        applyUpdate = apply
      },
      renderer,
      transport,
    }).run()
    await Promise.resolve()

    expect(statuses).toEqual(['waking'])
    resolveHydration?.({
      messages: restoredMessages,
      revision: 2,
      title: 'Hydrated chat',
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(statuses).toEqual(['waking', 'ready'])
    expect(renders.at(-1)).toEqual(restoredMessages)

    applyUpdate?.({
      messages: restoredMessages,
      revision: 3,
      title: 'Hydrated chat',
    })
    await Promise.resolve()

    expect(statuses).toEqual(['waking', 'ready'])
    resolvePrompt?.(undefined)
    await running
  })

  test('rehydrates the title when a background actor update arrives', async () => {
    let applyUpdate:
      | ((snapshot: {
          messages: UIMessage[]
          revision: number
          title?: string
        }) => void)
      | undefined
    let resolvePrompt: ((value: string | undefined) => void) | undefined
    const prompt = new Promise<string | undefined>(resolve => {
      resolvePrompt = resolve
    })
    const titles: Array<string | undefined> = []
    let cleanedUp = false
    const renderer: AgentTUIRenderer = {
      renderMessages(_messages, options) {
        titles.push(options?.title)
      },
      readPrompt() {
        return prompt
      },
      async renderStream() {
        return undefined
      },
    }
    const transport: ChatTransport<UIMessage> = {
      async sendMessages() {
        return new ReadableStream()
      },
      async reconnectToStream() {
        return null
      },
    }

    const running = new AgentTUIRunner({
      chatId: 'chat_missing_title',
      title: 'sensos · chat_missing_title',
      renderer,
      transport,
      hydrationUpdates: apply => {
        applyUpdate = apply
        return () => {
          cleanedUp = true
        }
      },
    }).run()
    await Promise.resolve()

    applyUpdate?.({
      messages: restoredMessages,
      revision: 1,
      title: 'Recovered title',
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(titles.at(-1)).toBe('Recovered title')
    resolvePrompt?.(undefined)
    await running
    expect(cleanedUp).toBe(true)
  })

  test('reconnects to a durable active stream before accepting another prompt', async () => {
    const calls: string[] = []
    const activeMessage = restoredMessages[0]
    if (!activeMessage) throw new Error('Missing restored user message')
    const activeMessages: UIMessage[] = [activeMessage]
    const renderer: AgentTUIRenderer = {
      renderMessages() {},
      async readPrompt() {
        calls.push('prompt')
        return undefined
      },
      async renderStream() {
        calls.push('stream')
        return {
          id: 'msg_resumed_assistant',
          role: 'assistant',
          parts: [{ type: 'text', text: 'resumed answer' }],
        }
      },
    }
    const transport: ChatTransport<UIMessage> = {
      async sendMessages() {
        throw new Error('A resumed stream must not submit a new message')
      },
      async reconnectToStream() {
        calls.push('reconnect')
        return new ReadableStream()
      },
    }

    await new AgentTUIRunner({
      chatId: 'chat_active',
      initialMessages: activeMessages,
      renderer,
      transport,
    }).run()

    expect(calls).toEqual(['reconnect', 'stream', 'prompt'])
  })

  test('wires an explicit stream stop without treating it as a message', async () => {
    let stopped = 0
    const renderer: AgentTUIRenderer = {
      renderMessages() {},
      async readPrompt() {
        return stopped === 0 ? 'start' : undefined
      },
      async renderStream(_result, options) {
        await options?.onStopDuringStream?.()
        return undefined
      },
    }
    const transport = {
      async sendMessages() {
        return new ReadableStream()
      },
      async reconnectToStream() {
        return null
      },
      async stopActiveRun() {
        stopped += 1
        return { cancelled: true }
      },
    } satisfies ChatTransport<UIMessage> & {
      stopActiveRun(): Promise<{ cancelled: boolean }>
    }

    await new AgentTUIRunner({
      chatId: 'chat_stoppable',
      renderer,
      transport,
    }).run()

    expect(stopped).toBe(1)
  })
})
