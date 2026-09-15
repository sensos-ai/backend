import { afterEach, describe, expect, test } from 'bun:test'
import {
  createAuthCliE2E,
  type AuthCliE2E,
} from '../../helpers/auth-cli-e2e'
import { waitForValue } from '../../helpers/wait'

const harnesses: AuthCliE2E[] = []

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(harness => harness.stop()))
})

async function harness(name: string) {
  const value = await createAuthCliE2E(name)
  harnesses.push(value)
  return value
}

describe('compiled auth CLI', () => {
  test('nested and alias API-key login persist identically without leaking secrets', async () => {
    const nested = await harness('nested-login')
    const alias = await harness('alias-login')
    const nestedSecret = 'nested-e2e-secret'
    const aliasSecret = 'alias-e2e-secret'

    const nestedResult = await nested.run([
      '--ci',
      'auth',
      'login',
      'vercel',
      '--apiKey',
      nestedSecret,
    ])
    const aliasResult = await alias.run([
      'login',
      '--agent',
      '--apiKey',
      aliasSecret,
      'vercel',
    ])

    expect(nestedResult.exitCode).toBe(0)
    expect(aliasResult.exitCode).toBe(0)
    expect(`${nestedResult.stdout}${nestedResult.stderr}`).not.toContain(
      nestedSecret
    )
    expect(`${aliasResult.stdout}${aliasResult.stderr}`).not.toContain(
      aliasSecret
    )
    expect(await nested.profile()).toMatchObject({
      credentialBackends: { gateway: 'file' },
      credentials: { gateway: { kind: 'apiKey', apiKey: nestedSecret } },
    })
    expect(await alias.profile()).toMatchObject({
      credentialBackends: { gateway: 'file' },
      credentials: { gateway: { kind: 'apiKey', apiKey: aliasSecret } },
    })
  })

  test('rejects unsupported strategies before side effects', async () => {
    const cli = await harness('unsupported')
    const secret = 'must-not-be-written'
    const result = await cli.run([
      '--ci',
      'login',
      'codex',
      '--apiKey',
      secret,
    ])

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain(
      'OpenAI Codex does not support this login strategy'
    )
    expect(result.stderr).not.toContain(secret)
    expect(await cli.profile()).toMatchObject({ credentials: {} })
  })

  test('configures storage and logout removes the recorded credential', async () => {
    const cli = await harness('config-logout')
    expect(
      (await cli.run(['--ci', 'auth', 'credentials', 'config'])).stdout
    ).toContain('Credential storage preference: file')
    expect(
      (
        await cli.run([
          '--ci',
          'auth',
          'credentials',
          'config',
          '--storage',
          'file',
        ])
      ).exitCode
    ).toBe(0)
    expect(
      (
        await cli.run([
          '--ci',
          'login',
          'vercel',
          '--apiKey',
          'logout-e2e-secret',
        ])
      ).exitCode
    ).toBe(0)
    expect(
      (await cli.run(['auth', '--agent', 'logout', 'vercel'])).exitCode
    ).toBe(0)
    expect(await cli.profile()).toMatchObject({
      storagePreference: 'file',
      credentialBackends: {},
      credentials: {},
    })
  })

  test('TTY shows provider picker while global automation flags suppress it', async () => {
    const interactive = await harness('interactive-picker')
    const pty = interactive.startPty(['auth', 'login'])
    await waitForValue(
      pty.screen,
      screen => screen.includes('Choose a provider'),
      {
        description: 'auth provider picker',
        timeoutMs: 5_000,
      }
    )
    await pty.sendControlC()
    await pty.waitForExit()

    const nonInteractive = await harness('noninteractive-picker')
    const result = await nonInteractive.run(['auth', 'login', '--agent'])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('Usage: sensos auth login')
    expect(result.stdout).not.toContain('Choose a provider')
  }, 15_000)
})
