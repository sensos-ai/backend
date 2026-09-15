import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  configureCredentialStorage,
  CredentialStorageError,
  persistProviderCredential,
  providerProfilePath,
  readProviderProfile,
  readProviderProfileWithCredential,
  type CredentialStorageDependencies,
  type KeyringEntry,
} from '@/auth/profile'

function fakeKeyring(
  values = new Map<string, string>(),
  failure?: Error
): CredentialStorageDependencies {
  return {
    platform: 'linux',
    createKeyringEntry(_service, account, options): KeyringEntry {
      expect(options).toEqual({ linux: { store: 'secret-service' } })
      if (failure) throw failure
      return {
        getPassword: async () => values.get(account),
        setPassword: async value => {
          values.set(account, value)
        },
        deleteCredential: async () => values.delete(account),
      }
    },
  }
}

async function withDirectory(
  run: (directory: string) => Promise<void>
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'sensos-storage-'))
  try {
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const apiKeyCredential = { kind: 'apiKey', apiKey: 'secret-key' } as const

describe('credential storage', () => {
  test('persists keyring credentials without plaintext in the profile', async () => {
    await withDirectory(async directory => {
      const values = new Map<string, string>()
      const dependencies = fakeKeyring(values)
      await configureCredentialStorage('keyring', directory, dependencies)
      await persistProviderCredential(
        'gateway',
        apiKeyCredential,
        directory,
        dependencies
      )

      const document = await readFile(
        providerProfilePath(directory),
        'utf8'
      )
      expect(document).not.toContain('secret-key')
      expect(JSON.parse(document)).toMatchObject({
        version: 3,
        storagePreference: 'keyring',
        credentialBackends: { gateway: 'keyring' },
        credentials: {},
      })
      expect(
        (
          await readProviderProfileWithCredential(
            'gateway',
            directory,
            dependencies
          )
        ).credentials.gateway
      ).toEqual(apiKeyCredential)
    })
  })

  test('auto falls back only when the keyring is unavailable', async () => {
    await withDirectory(async directory => {
      const unavailable = fakeKeyring(
        new Map(),
        new Error('Secret Service unavailable')
      )
      const profile = await persistProviderCredential(
        'gateway',
        apiKeyCredential,
        directory,
        unavailable
      )
      expect(profile.credentialBackends.gateway).toBe('file')
      expect(
        await readFile(providerProfilePath(directory), 'utf8')
      ).toContain('secret-key')
    })

    await withDirectory(async directory => {
      const locked = fakeKeyring(new Map(), new Error('keychain locked'))
      await expect(
        persistProviderCredential(
          'gateway',
          apiKeyCredential,
          directory,
          locked
        )
      ).rejects.toMatchObject({ code: 'locked' })
      expect(
        await readFile(providerProfilePath(directory), 'utf8').catch(
          () => undefined
        )
      ).toBeUndefined()
    })
  })

  test('migrates legacy file credentials to keyring transactionally', async () => {
    await withDirectory(async directory => {
      await writeFile(
        providerProfilePath(directory),
        JSON.stringify({
          version: 2,
          activeProvider: 'gateway',
          credentials: { gateway: apiKeyCredential },
        })
      )
      const dependencies = fakeKeyring()
      const migrated = await configureCredentialStorage(
        'keyring',
        directory,
        dependencies
      )
      expect(migrated.credentialBackends.gateway).toBe('keyring')
      const document = await readFile(
        providerProfilePath(directory),
        'utf8'
      )
      expect(document).not.toContain('secret-key')
      expect(
        (
          await readProviderProfileWithCredential(
            'gateway',
            directory,
            dependencies
          )
        ).credentials.gateway
      ).toEqual(apiKeyCredential)
    })
  })

  test('treats a native null keyring result as a missing credential', async () => {
    await withDirectory(async directory => {
      await writeFile(
        providerProfilePath(directory),
        JSON.stringify({
          version: 2,
          activeProvider: 'gateway',
          credentials: { gateway: apiKeyCredential },
        })
      )
      const values = new Map<string, string>()
      const dependencies: CredentialStorageDependencies = {
        createKeyringEntry: (_service, account) => ({
          getPassword: async () => values.get(account) ?? null,
          setPassword: async value => {
            values.set(account, value)
          },
          deleteCredential: async () => values.delete(account),
        }),
      }

      const migrated = await configureCredentialStorage(
        'auto',
        directory,
        dependencies
      )

      expect(migrated.credentialBackends.gateway).toBe('keyring')
      expect(
        (
          await readProviderProfileWithCredential(
            'gateway',
            directory,
            dependencies
          )
        ).credentials.gateway
      ).toEqual(apiKeyCredential)
    })
  })

  test('rejects corrupt keyring values instead of treating them as absent', async () => {
    await withDirectory(async directory => {
      const values = new Map([
        [
          'provider:gateway:v1',
          '{"version":1,"credential":{"kind":"apiKey"}}',
        ],
      ])
      await writeFile(
        providerProfilePath(directory),
        JSON.stringify({
          version: 3,
          activeProvider: 'gateway',
          storagePreference: 'keyring',
          credentialBackends: { gateway: 'keyring' },
          credentials: {},
        })
      )
      await expect(
        readProviderProfileWithCredential(
          'gateway',
          directory,
          fakeKeyring(values)
        )
      ).rejects.toBeInstanceOf(CredentialStorageError)
    })
  })

  test('loads only the requested keyring credential', async () => {
    await withDirectory(async directory => {
      const reads: string[] = []
      const values = new Map([
        [
          'provider:gateway:v1',
          JSON.stringify({ version: 1, credential: apiKeyCredential }),
        ],
        [
          'provider:codex:v1',
          JSON.stringify({
            version: 1,
            credential: {
              kind: 'oauth',
              accessToken: 'access',
              refreshToken: 'refresh',
              expiresAt: Date.now() + 60_000,
              accountId: 'account',
            },
          }),
        ],
      ])
      await writeFile(
        providerProfilePath(directory),
        JSON.stringify({
          version: 3,
          activeProvider: 'gateway',
          storagePreference: 'keyring',
          credentialBackends: {
            gateway: 'keyring',
            codex: 'keyring',
          },
          credentials: {},
        })
      )
      const dependencies: CredentialStorageDependencies = {
        createKeyringEntry: (_service, account) => ({
          getPassword: async () => {
            reads.push(account)
            return values.get(account)
          },
          setPassword: async () => undefined,
          deleteCredential: async () => false,
        }),
      }

      const metadata = await readProviderProfile(directory)
      expect(metadata.credentials).toEqual({})
      expect(reads).toEqual([])

      const profile = await readProviderProfileWithCredential(
        'gateway',
        directory,
        dependencies
      )
      expect(profile.credentials.gateway).toEqual(apiKeyCredential)
      expect(profile.credentials.codex).toBeUndefined()
      expect(reads).toEqual(['provider:gateway:v1'])
    })
  })
})
