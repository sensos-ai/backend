import { describe, expect, test } from 'bun:test'
import { normalizeCliInvocation } from '@/cli/state'
import {
  parseCredentialsConfigRequest,
  parseLoginRequest,
  parseLogoutRequest,
} from '@/cli/commands/auth/parse'

const authKeys = ['vercel', 'codex'] as const

describe('CLI auth command parsing', () => {
  test('strips global automation flags wherever they occur', () => {
    expect(
      normalizeCliInvocation(
        ['auth', '--ci', 'login', 'codex', '--agent', '--device'],
        { stdinIsTTY: true, stdoutIsTTY: true }
      )
    ).toEqual({
      argv: ['auth', 'login', 'codex', '--device'],
      state: { isInteractive: false },
    })
  })

  test('requires both terminal streams for interactive mode', () => {
    expect(
      normalizeCliInvocation([], {
        stdinIsTTY: true,
        stdoutIsTTY: false,
      }).state.isInteractive
    ).toBe(false)
    expect(
      normalizeCliInvocation([], {
        stdinIsTTY: true,
        stdoutIsTTY: true,
      }).state.isInteractive
    ).toBe(true)
  })

  test('parses provider and strategy flags independent of position', () => {
    expect(parseLoginRequest(['--device', 'codex'], authKeys)).toEqual({
      provider: 'codex',
      strategy: { type: 'oauth-device' },
    })
    expect(
      parseLoginRequest(['--apiKey', 'secret', 'vercel'], authKeys)
    ).toEqual({
      provider: 'vercel',
      strategy: { type: 'apiKey', apiKey: 'secret' },
    })
  })

  test('rejects conflicting strategies and extra values without echoing keys', () => {
    expect(() =>
      parseLoginRequest(
        ['codex', '--device', '--apiKey', 'secret'],
        authKeys
      )
    ).toThrow('Login strategy flags cannot be combined.')
    expect(() =>
      parseLogoutRequest(['codex', 'vercel'], authKeys)
    ).toThrow('Logout accepts only one provider.')
  })

  test('parses credential storage preferences strictly', () => {
    expect(
      parseCredentialsConfigRequest(['--storage', 'keyring'])
    ).toEqual({
      storage: 'keyring',
    })
    expect(() =>
      parseCredentialsConfigRequest(['--storage', 'ephemeral'])
    ).toThrow('Unknown credential storage preference: ephemeral')
  })
})
