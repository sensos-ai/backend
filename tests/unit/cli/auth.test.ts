import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearProviderCredential,
  providerProfilePath,
  readProviderProfile,
  writeProviderProfile,
} from '@/auth/profile'

describe('provider profile', () => {
  test('persists private provider credentials outside project state', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sensos-auth-'))
    try {
      await writeProviderProfile(
        {
          version: 1,
          activeProvider: 'gateway',
          vercel: {
            accessToken: 'vercel-token',
            refreshToken: 'refresh-token',
            expiresAt: 123,
            teamId: 'team_test',
          },
        },
        directory
      )

      expect(await readProviderProfile(directory)).toMatchObject({
        activeProvider: 'gateway',
        vercel: { teamId: 'team_test' },
      })
      expect(
        await readFile(providerProfilePath(directory), 'utf8')
      ).toContain('vercel-token')
      expect(
        (await stat(providerProfilePath(directory))).mode & 0o777
      ).toBe(0o600)

      await clearProviderCredential('vercel', directory)
      expect(await readProviderProfile(directory)).toEqual({
        version: 1,
        activeProvider: 'gateway',
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
