import { describe, expect, test } from 'bun:test'
import { createGatewayHarnessProvider } from '@/chat/harness/providers/gateway'
import { createCodexHarnessProvider } from '@/chat/harness/providers/openai'

const signal = new AbortController().signal

describe('provider-owned login flows', () => {
  test('rejects an unsupported strategy before provider side effects', async () => {
    let sideEffects = 0
    const provider = createCodexHarnessProvider(undefined, {
      loginWithPkce: async () => {
        sideEffects += 1
        throw new Error('unexpected')
      },
    })

    await expect(
      provider.auth.login({
        strategy: { type: 'apiKey', apiKey: 'secret' },
        signal,
      } as never)
    ).rejects.toThrow(
      'OpenAI Codex does not support this login strategy, available methods are: oauth-pkce, oauth-device'
    )
    expect(sideEffects).toBe(0)
  })

  test('Codex dispatches PKCE and device flows and owns their copy', async () => {
    const messages: string[] = []
    const base = {
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresAt: Date.now() + 60_000,
      accountId: 'account',
    }
    let pkce = 0
    let device = 0
    const provider = createCodexHarnessProvider(undefined, {
      log: message => messages.push(message),
      loginWithPkce: async (_openUrl, receivedSignal) => {
        expect(receivedSignal).toBe(signal)
        pkce += 1
        return base
      },
      loginWithDevice: async options => {
        expect(options.signal).toBe(signal)
        device += 1
        return base
      },
    })

    await provider.auth.login({ strategy: { type: 'oauth-pkce' }, signal })
    await provider.auth.login({
      strategy: { type: 'oauth-device' },
      signal,
    })

    expect({ pkce, device }).toEqual({ pkce: 1, device: 1 })
    expect(messages).toEqual([
      'Opening OpenAI Codex sign-in in your browser.',
      'Connected to OpenAI Codex.',
      'Starting OpenAI Codex device sign-in.',
      'Connected to OpenAI Codex.',
    ])
  })

  test('Gateway API key prefers explicit input and never runs OAuth', async () => {
    let requests = 0
    const provider = createGatewayHarnessProvider(undefined, {
      env: { AI_GATEWAY_API_KEY: 'environment-secret' },
      fetch: (async () => {
        requests += 1
        throw new Error('unexpected OAuth request')
      }) as unknown as typeof fetch,
    })

    await expect(
      provider.auth.login({
        strategy: { type: 'apiKey', apiKey: 'explicit-secret' },
        signal,
      })
    ).resolves.toEqual({ kind: 'apiKey', apiKey: 'explicit-secret' })
    await expect(
      provider.auth.login({ strategy: { type: 'apiKey' }, signal })
    ).resolves.toEqual({ kind: 'apiKey', apiKey: 'environment-secret' })
    expect(requests).toBe(0)
  })

  test('Gateway rejects an explicitly empty API key without leaking it', async () => {
    const provider = createGatewayHarnessProvider(undefined, {
      env: { AI_GATEWAY_API_KEY: 'environment-secret' },
    })
    await expect(
      provider.auth.login({
        strategy: { type: 'apiKey', apiKey: '   ' },
        signal,
      })
    ).rejects.toThrow(
      'Missing API key. Pass `--apiKey <token>` or set AI_GATEWAY_API_KEY.'
    )
  })

  test('Gateway device login fails non-interactively when team choice is ambiguous', async () => {
    const requests: Request[] = []
    const signals: Array<AbortSignal | null | undefined> = []
    let selections = 0
    const provider = createGatewayHarnessProvider(undefined, {
      interaction: {
        isInteractive: false,
        openUrl: () => Promise.resolve(),
        select: async () => {
          selections += 1
          throw new Error('unexpected selection')
        },
        log: () => {},
        error: () => {},
      },
      sleep: () => Promise.resolve(),
      fetch: (async (input, init) => {
        const request = new Request(input, init)
        requests.push(request)
        signals.push(init?.signal)
        if (request.url.endsWith('/.well-known/openid-configuration')) {
          return Response.json({
            device_authorization_endpoint: 'https://vercel.test/device',
            token_endpoint: 'https://vercel.test/token',
          })
        }
        if (request.url === 'https://vercel.test/device') {
          return Response.json({
            device_code: 'device',
            user_code: 'code',
            verification_uri: 'https://vercel.test/verify',
            verification_uri_complete:
              'https://vercel.test/verify?code=code',
            expires_in: 60,
            interval: 0,
          })
        }
        if (request.url === 'https://vercel.test/token') {
          return Response.json({
            access_token: 'access',
            expires_in: 3600,
          })
        }
        return Response.json({
          teams: [
            { id: 'one', name: 'One' },
            { id: 'two', name: 'Two' },
          ],
        })
      }) as typeof fetch,
    })

    await expect(
      provider.auth.login({ strategy: { type: 'oauth-device' }, signal })
    ).rejects.toThrow(
      'Multiple Vercel teams are available. Run `sensos login vercel` interactively to choose one.'
    )
    expect(selections).toBe(0)
    expect(signals.every(received => received === signal)).toBe(true)
  })
})
