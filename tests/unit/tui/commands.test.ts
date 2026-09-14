import { describe, expect, test } from 'bun:test'
import {
  findSlashCommand,
  matchingSlashCommands,
  parseStreamingInput,
  slashCommandCompletion,
} from '@/chat/tui/commands'

const commands = [
  { name: '/model' as const, description: 'model', run: () => undefined },
  {
    name: '/switch-session' as const,
    description: 'switch session',
    run: () => 'switch-session' as const,
  },
]

describe('slash commands', () => {
  test('offers and narrows commands from a leading slash', () => {
    expect(
      matchingSlashCommands('/', commands).map(item => item.name)
    ).toEqual(['/model', '/switch-session'])
    expect(
      matchingSlashCommands('/m', commands).map(item => item.name)
    ).toEqual(['/model'])
    expect(matchingSlashCommands('hello', commands)).toEqual([])
  })

  test('only executes an exact command', () => {
    expect(findSlashCommand('/MODEL', commands)?.name).toBe('/model')
    expect(findSlashCommand('/mo', commands)).toBeUndefined()
  })

  test('completes only an unambiguous partial command', () => {
    expect(slashCommandCompletion('/sw', commands)?.name).toBe(
      '/switch-session'
    )
    expect(slashCommandCompletion('/', commands)).toBeUndefined()
    expect(
      slashCommandCompletion('/switch-session', commands)
    ).toBeUndefined()
    expect(
      slashCommandCompletion('/sw argument', commands)
    ).toBeUndefined()
  })

  test('separates stream controls from delivered messages', () => {
    expect(parseStreamingInput('/switch-session')).toEqual({
      type: 'switch-session',
    })
    expect(parseStreamingInput('/exit')).toEqual({
      type: 'delivery',
      prompt: '/exit',
      priority: 'adaptive',
    })
    expect(parseStreamingInput('/STOP')).toEqual({ type: 'stop' })
    expect(parseStreamingInput('/interrupt change course')).toEqual({
      type: 'delivery',
      prompt: 'change course',
      priority: 'now',
    })
    expect(parseStreamingInput('/queue do this next')).toEqual({
      type: 'delivery',
      prompt: 'do this next',
      priority: 'next',
    })
    expect(parseStreamingInput('ordinary message')).toEqual({
      type: 'delivery',
      prompt: 'ordinary message',
      priority: 'adaptive',
    })
  })
})
