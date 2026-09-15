import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  providerProfilePath,
  readFreshProviderProfile,
  writeProviderProfile,
} from '@/auth/profile'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map(directory => rm(directory, { recursive: true, force: true }))
  )
})

test('refreshes once under a lock and persists the rotated credential', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sensos-refresh-'))
  directories.push(directory)
  await writeProviderProfile(
    {
      version: 3,
      activeProvider: 'codex',
      storagePreference: 'file',
      credentialBackends: { codex: 'file' },
      credentials: {
        codex: {
          kind: 'oauth',
          accessToken: 'old-access',
          refreshToken: 'old-refresh',
          expiresAt: 0,
          accountId: 'old-account',
        },
      },
    },
    directory
  )

  const payload = Buffer.from(
    JSON.stringify({
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'new-account',
      },
    })
  ).toString('base64url')
  let refreshes = 0
  const dependencies = {
    codex: {
      fetch: async () => {
        refreshes += 1
        await Bun.sleep(20)
        return Response.json({
          access_token: `header.${payload}.signature`,
          refresh_token: 'new-refresh',
          expires_in: 3600,
        })
      },
    },
  }

  const [first, second] = await Promise.all([
    readFreshProviderProfile('codex', directory, dependencies),
    readFreshProviderProfile('codex', directory, dependencies),
  ])

  expect(refreshes).toBe(1)
  expect(first.credentials.codex?.refreshToken).toBe('new-refresh')
  expect(second.credentials.codex?.refreshToken).toBe('new-refresh')
  const persisted = JSON.parse(
    await readFile(providerProfilePath(directory), 'utf8')
  )
  expect(persisted.credentials.codex.refreshToken).toBe('new-refresh')
})

test('does not refresh a credential outside the expiry window', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sensos-refresh-'))
  directories.push(directory)
  await writeProviderProfile(
    {
      version: 3,
      activeProvider: 'gateway',
      storagePreference: 'file',
      credentialBackends: { gateway: 'file' },
      credentials: {
        gateway: {
          kind: 'oauth',
          accessToken: 'access',
          refreshToken: 'refresh',
          expiresAt: Date.now() + 120_000,
          teamId: 'team',
        },
      },
    },
    directory
  )
  let requests = 0

  const profile = await readFreshProviderProfile('gateway', directory, {
    gateway: {
      fetch: (async () => {
        requests += 1
        throw new Error('unexpected refresh')
      }) as unknown as typeof fetch,
    },
  })

  expect(profile.credentials.gateway).toMatchObject({
    kind: 'oauth',
    accessToken: 'access',
  })
  expect(requests).toBe(0)
})
