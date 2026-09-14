import { expect, test } from 'bun:test'
import { getCodexUser } from '@/auth/oauth/codex'
import { getVercelUser } from '@/auth/oauth/vercel'

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
