import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearProviderCredential,
  providerProfilePath,
  readProviderProfile,
  writeProviderProfile,
} from '@/auth/profile'

describe('provider profile', () => {
  test('migrates version 1 provider credentials into the registry shape', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sensos-auth-v1-'))
    try {
      await writeFile(
        providerProfilePath(directory),
        JSON.stringify({
          version: 1,
          activeProvider: 'codex',
          vercel: {
            accessToken: 'gateway-token',
            expiresAt: 123,
            teamId: 'team_test',
          },
          codex: {
            accessToken: 'codex-token',
            refreshToken: 'refresh-token',
            expiresAt: 456,
            accountId: 'account-id',
          },
        })
      )

      expect(await readProviderProfile(directory)).toEqual({
        version: 3,
        activeProvider: 'codex',
        storagePreference: 'auto',
        credentialBackends: { gateway: 'file', codex: 'file' },
        credentials: {
          gateway: {
            kind: 'oauth',
            accessToken: 'gateway-token',
            expiresAt: 123,
            teamId: 'team_test',
          },
          codex: {
            kind: 'oauth',
            accessToken: 'codex-token',
            refreshToken: 'refresh-token',
            expiresAt: 456,
            accountId: 'account-id',
          },
        },
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('reads version 2 credentials without rewriting the source file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sensos-auth-v2-'))
    try {
      const source = JSON.stringify({
        version: 2,
        activeProvider: 'gateway',
        credentials: {
          gateway: { kind: 'apiKey', apiKey: 'legacy-key' },
        },
      })
      await writeFile(providerProfilePath(directory), source)

      expect(await readProviderProfile(directory)).toMatchObject({
        version: 3,
        storagePreference: 'auto',
        credentialBackends: { gateway: 'file' },
      })
      expect(await readFile(providerProfilePath(directory), 'utf8')).toBe(
        source
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('persists private provider credentials outside project state', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sensos-auth-'))
    try {
      await writeProviderProfile(
        {
          version: 3,
          activeProvider: 'gateway',
          storagePreference: 'file',
          credentialBackends: { gateway: 'file' },
          credentials: {
            gateway: {
              kind: 'oauth',
              accessToken: 'vercel-token',
              refreshToken: 'refresh-token',
              expiresAt: 123,
              teamId: 'team_test',
            },
          },
        },
        directory
      )

      expect(await readProviderProfile(directory)).toMatchObject({
        activeProvider: 'gateway',
        credentials: { gateway: { teamId: 'team_test' } },
      })
      expect(
        await readFile(providerProfilePath(directory), 'utf8')
      ).toContain('vercel-token')
      expect(
        (await stat(providerProfilePath(directory))).mode & 0o777
      ).toBe(0o600)

      await clearProviderCredential('gateway', directory)
      expect(await readProviderProfile(directory)).toEqual({
        version: 3,
        activeProvider: 'codex',
        storagePreference: 'file',
        credentialBackends: {},
        credentials: {},
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
