import { describe, expect, test } from 'bun:test'
import {
  renderScreenViewport,
  stripAnsi,
  visibleLength,
} from '@/chat/tui/tui/layout'

describe('slash command menu layout', () => {
  test('renders as a full-width bordered region with aligned columns', () => {
    const frame = renderScreenViewport({
      width: 50,
      height: 12,
      title: 'Chat',
      visibleBodyLines: ['Transcript'],
      input: '/',
      inputActive: true,
      commandSuggestions: [
        {
          name: '/switch-session',
          description: 'Switch sessions',
          selected: true,
        },
        {
          name: '/model',
          description: 'Choose the model',
        },
      ],
    })
    const lines = frame.split('\n')

    expect(lines).toHaveLength(12)
    expect(lines.every(line => visibleLength(line) === 50)).toBe(true)
    expect(lines[5]).toBe(`┌${'─'.repeat(48)}┐`)
    expect(lines[6]).toContain('\x1b[95m')
    expect(lines[6]).not.toContain('\x1b[7m')
    expect(lines[7]).toContain('\x1b[2m')
    expect(stripAnsi(lines[6] ?? '').indexOf('Switch sessions')).toBe(
      stripAnsi(lines[7] ?? '').indexOf('Choose the model')
    )
    expect(lines[8]).toBe(`└${'─'.repeat(48)}┘`)
  })
})
