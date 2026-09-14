import { expect, test } from 'bun:test'
import { getCodexUser, refreshCodexCredential } from '@/auth/oauth/codex'
import {
  getVercelUser,
  refreshVercelCredential,
} from '@/auth/oauth/vercel'

test('normalizes the Vercel user and selected team', async () => {
  const requests: string[] = []
  const user = await getVercelUser(
    {
      accessToken: 'token',
      expiresAt: Date.now() + 60_000,
      teamId: 'team_123',
    },
    async input => {
      const url = String(input)
      requests.push(url)
      return Response.json(
        url.endsWith('/v2/user')
          ? { user: { name: 'Ada Lovelace', email: 'ada@example.com' } }
          : { id: 'team_123', name: 'Analytical Engines' }
      )
    }
  )

  expect(requests).toEqual([
    'https://api.vercel.com/v2/user',
    'https://api.vercel.com/v2/teams/team_123',
  ])
  expect(user).toEqual({
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    affiliation: { kind: 'team', name: 'Analytical Engines' },
  })
})

test('tells the user to log in again when Vercel rejects the token', async () => {
  await expect(
    getVercelUser({ accessToken: 'expired', expiresAt: 0 }, async () =>
      Response.json({}, { status: 403 })
    )
  ).rejects.toThrow(
    'Vercel login expired. Run `sensos login vercel` again.'
  )
})

test('normalizes the Codex user and default organization', async () => {
  const user = await getCodexUser(
    {
      accessToken: 'token',
      refreshToken: 'refresh',
      expiresAt: Date.now() + 60_000,
      accountId: 'account_123',
    },
    async (_input, init) => {
      expect(init?.headers).toEqual({
        Authorization: 'Bearer token',
        'chatgpt-account-id': 'account_123',
      })
      return Response.json({
        name: 'Grace Hopper',
        email: 'grace@example.com',
        orgs: {
          data: [
            { title: 'Other Org', is_default: false },
            { title: 'Compiler Labs', is_default: true },
          ],
        },
      })
    }
  )

  expect(user).toEqual({
    name: 'Grace Hopper',
    email: 'grace@example.com',
    affiliation: { kind: 'organization', name: 'Compiler Labs' },
  })
})

test('refreshes and rotates a Vercel credential', async () => {
  const requests: Request[] = []
  const credential = await refreshVercelCredential(
    {
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      expiresAt: 0,
    },
    async (input, init) => {
      const request = new Request(input, init)
      requests.push(request)
      if (request.url.endsWith('/.well-known/openid-configuration')) {
        return Response.json({
          device_authorization_endpoint: 'https://vercel.test/device',
          token_endpoint: 'https://vercel.test/token',
        })
      }
      return Response.json({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 3600,
      })
    }
  )

  expect(requests).toHaveLength(2)
  const refreshBody = await requests[1]?.text()
  expect(refreshBody).toContain('grant_type=refresh_token')
  expect(refreshBody).toContain('refresh_token=old-refresh')
  expect(credential.accessToken).toBe('new-access')
  expect(credential.refreshToken).toBe('new-refresh')
  expect(credential.expiresAt).toBeGreaterThan(Date.now())
})

test('refreshes and rotates a Codex credential', async () => {
  const payload = Buffer.from(
    JSON.stringify({
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'account-new',
      },
    })
  ).toString('base64url')
  let request: Request | undefined
  const credential = await refreshCodexCredential(
    {
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      expiresAt: 0,
      accountId: 'account-old',
    },
    async (input, init) => {
      request = new Request(input, init)
      return Response.json({
        access_token: `header.${payload}.signature`,
        refresh_token: 'new-refresh',
        expires_in: 3600,
      })
    }
  )

  expect(await request?.text()).toContain('refresh_token=old-refresh')
  expect(credential.refreshToken).toBe('new-refresh')
  expect(credential.accountId).toBe('account-new')
  expect(credential.expiresAt).toBeGreaterThan(Date.now())
})
