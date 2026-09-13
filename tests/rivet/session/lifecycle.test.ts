import { describe, expect, test } from 'bun:test'
import {
  createState,
  parseAgentOsSoftwarePaths,
} from '@/runtime/actors/session/lifecycle'

describe('parseAgentOsSoftwarePaths', () => {
  test('preserves normal server defaults when configuration is absent', () => {
    expect(parseAgentOsSoftwarePaths(undefined)).toBeUndefined()
  })

  test('maps absolute materialized paths to AgentOS software refs', () => {
    expect(
      parseAgentOsSoftwarePaths(JSON.stringify(['/tmp/core.aospkg']))
    ).toEqual([{ packagePath: '/tmp/core.aospkg' }])
  })

  test.each(['not json', '[]', '["relative.aospkg"]', '{}'])(
    'rejects invalid configuration: %s',
    raw => {
      expect(() => parseAgentOsSoftwarePaths(raw)).toThrow(
        'SENSOS_AGENTOS_SOFTWARE_PATHS'
      )
    }
  )
})

describe('createState', () => {
  test('keeps initial messages in durable actor state', async () => {
    const initialMessages = [
      {
        id: 'msg_initial',
        role: 'user' as const,
        parts: [{ type: 'text' as const, text: 'hello' }],
      },
    ]

    const state = await createState({} as never, {
      sessionId: 'chat_initial',
      cwd: '/tmp/workspace',
      initialMessages,
    })

    expect(state.initialMessages).toEqual(initialMessages)
  })

  test('resolves feature flags into globally available actor config', async () => {
    const state = await createState({} as never, {
      sessionId: 'chat_features',
      cwd: '/tmp/workspace',
      features: { useMockModel: true },
    })

    expect(state.config.features).toEqual({ useMockModel: true })
  })
})
