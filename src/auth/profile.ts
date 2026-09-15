import { AsyncEntry, type EntryOptions } from '@napi-rs/keyring'
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { productConfigDir } from '@/config/paths'
import type {
  ModelProvider,
  ProviderDependencies,
  ProviderCredentials,
} from '@/chat/harness/providers/registry'
import { createHarnessProviderRegistry } from '@/chat/harness/providers/registry'
import type { VercelCredential } from '@/chat/harness/providers/gateway'
import type { CodexCredential } from '@/chat/harness/providers/openai'

export type CredentialStoragePreference = 'keyring' | 'file' | 'auto'
export type CredentialBackend = Exclude<
  CredentialStoragePreference,
  'auto'
>
export type ProviderProfile = {
  version: 3
  activeProvider: ModelProvider
  storagePreference: CredentialStoragePreference
  credentialBackends: Partial<Record<ModelProvider, CredentialBackend>>
  /** Hydrated credentials. Keyring-owned values are omitted when serialized. */
  credentials: ProviderCredentials
}
export interface CredentialStore {
  readonly backend: CredentialBackend
  read(provider: ModelProvider): Promise<unknown | undefined>
  write(provider: ModelProvider, credential: unknown): Promise<void>
  delete(provider: ModelProvider): Promise<void>
}
export type KeyringEntry = Omit<
  Pick<AsyncEntry, 'getPassword' | 'setPassword' | 'deleteCredential'>,
  'getPassword'
> & {
  /** Native keyring implementations may return null for a missing entry. */
  getPassword(): Promise<string | null | undefined>
}
export type CredentialStorageDependencies = {
  createKeyringEntry?: (
    service: string,
    account: string,
    options?: EntryOptions
  ) => KeyringEntry
  platform?: NodeJS.Platform
}
export class CredentialStorageError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'unavailable'
      | 'locked'
      | 'denied'
      | 'corrupt'
      | 'conflict'
      | 'partial-cleanup',
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'CredentialStorageError'
  }
}
export type { CodexCredential, ModelProvider, VercelCredential }

const KEYRING_SERVICE = 'sensos'
const LOCK_STALE_MS = 30_000
const LOCK_WAIT_MS = 5_000

export function providerProfilePath(
  directory = productConfigDir()
): string {
  return join(directory, 'auth.json')
}
function emptyProfile(): ProviderProfile {
  return {
    version: 3,
    activeProvider: 'gateway',
    storagePreference: 'auto',
    credentialBackends: {},
    credentials: {},
  }
}
function invalidCredentials(cause?: unknown): CredentialStorageError {
  return new CredentialStorageError(
    'Sensos credentials are invalid. Run `sensos login`.',
    'corrupt',
    cause === undefined ? undefined : { cause }
  )
}
function normalizeCredential(
  provider: ModelProvider,
  value: unknown
): VercelCredential | CodexCredential {
  if (!value || typeof value !== 'object') throw invalidCredentials()
  const candidate = value as Record<string, unknown>
  const normalized =
    candidate.kind === undefined
      ? { ...candidate, kind: 'oauth' as const }
      : candidate
  const registry = createHarnessProviderRegistry()
  if (!registry[provider].auth.isCredential(normalized as never))
    throw invalidCredentials()
  return normalized as VercelCredential | CodexCredential
}
function parseProfileDocument(value: unknown): ProviderProfile {
  if (!value || typeof value !== 'object') throw invalidCredentials()
  const candidate = value as {
    version?: unknown
    activeProvider?: unknown
    storagePreference?: unknown
    credentialBackends?: Partial<Record<ModelProvider, unknown>>
    credentials?: Record<string, unknown>
    vercel?: unknown
    codex?: unknown
  }
  if (
    candidate.activeProvider !== 'gateway' &&
    candidate.activeProvider !== 'codex'
  )
    throw invalidCredentials()
  if (candidate.version === 1 || candidate.version === 2) {
    const legacy =
      candidate.version === 1
        ? { gateway: candidate.vercel, codex: candidate.codex }
        : candidate.credentials
    const credentials: ProviderCredentials = {}
    for (const provider of ['gateway', 'codex'] as const) {
      const credential = legacy?.[provider]
      if (credential !== undefined)
        credentials[provider] = normalizeCredential(
          provider,
          credential
        ) as never
    }
    return {
      version: 3,
      activeProvider: candidate.activeProvider,
      storagePreference: 'auto',
      credentialBackends: Object.fromEntries(
        Object.keys(credentials).map(provider => [provider, 'file'])
      ),
      credentials,
    }
  }
  if (
    candidate.version !== 3 ||
    !['keyring', 'file', 'auto'].includes(
      candidate.storagePreference as string
    )
  ) {
    throw invalidCredentials()
  }
  const credentials: ProviderCredentials = {}
  const credentialBackends: ProviderProfile['credentialBackends'] = {}
  for (const provider of ['gateway', 'codex'] as const) {
    const backend = candidate.credentialBackends?.[provider]
    if (
      backend !== undefined &&
      backend !== 'file' &&
      backend !== 'keyring'
    )
      throw invalidCredentials()
    if (backend) credentialBackends[provider] = backend
    const credential = candidate.credentials?.[provider]
    if (backend === 'keyring' && credential !== undefined)
      throw invalidCredentials()
    if (credential !== undefined) {
      credentials[provider] = normalizeCredential(
        provider,
        credential
      ) as never
      credentialBackends[provider] ??= 'file'
    }
  }
  return {
    version: 3,
    activeProvider: candidate.activeProvider,
    storagePreference:
      candidate.storagePreference as CredentialStoragePreference,
    credentialBackends,
    credentials,
  }
}
async function readProfileDocument(
  directory: string
): Promise<ProviderProfile> {
  try {
    return parseProfileDocument(
      JSON.parse(await readFile(providerProfilePath(directory), 'utf8'))
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return emptyProfile()
    if (error instanceof CredentialStorageError) throw error
    throw invalidCredentials(error)
  }
}
function serializeProfile(profile: ProviderProfile): string {
  const credentials: ProviderCredentials = {}
  for (const provider of ['gateway', 'codex'] as const) {
    if (profile.credentialBackends[provider] === 'file')
      credentials[provider] = profile.credentials[provider] as never
  }
  return `${JSON.stringify({ ...profile, credentials }, null, 2)}\n`
}
async function writeProfileDocument(
  profile: ProviderProfile,
  directory: string
): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  const path = providerProfilePath(directory)
  const temporaryPath = `${path}.${process.pid}.tmp`
  await writeFile(temporaryPath, serializeProfile(profile), {
    mode: 0o600,
  })
  await chmod(temporaryPath, 0o600)
  await rename(temporaryPath, path)
  await chmod(path, 0o600)
}
function classifyKeyringError(error: unknown): CredentialStorageError {
  if (error instanceof CredentialStorageError) return error
  const lower = (
    error instanceof Error ? error.message : String(error)
  ).toLowerCase()
  const code = lower.includes('lock')
    ? 'locked'
    : lower.includes('denied') || lower.includes('permission')
      ? 'denied'
      : 'unavailable'
  return new CredentialStorageError(
    `Operating-system credential store is ${code}.`,
    code,
    { cause: error }
  )
}
function keyringOptions(
  platform: NodeJS.Platform
): EntryOptions | undefined {
  return platform === 'linux'
    ? { linux: { store: 'secret-service' } }
    : undefined
}
export function createKeyringCredentialStore(
  dependencies: CredentialStorageDependencies = {}
): CredentialStore {
  const createEntry =
    dependencies.createKeyringEntry ??
    ((service, account, options) =>
      new AsyncEntry(service, account, options))
  const platform = dependencies.platform ?? process.platform
  const entry = (provider: ModelProvider) => {
    try {
      return createEntry(
        KEYRING_SERVICE,
        `provider:${provider}:v1`,
        keyringOptions(platform)
      )
    } catch (error) {
      throw classifyKeyringError(error)
    }
  }
  return {
    backend: 'keyring',
    async read(provider) {
      let encoded: string | null | undefined
      try {
        encoded = await entry(provider).getPassword()
      } catch (error) {
        throw classifyKeyringError(error)
      }
      if (encoded == null) return undefined
      try {
        const envelope = JSON.parse(encoded) as {
          version?: unknown
          credential?: unknown
        }
        if (envelope.version !== 1) throw invalidCredentials()
        return normalizeCredential(provider, envelope.credential)
      } catch (error) {
        throw error instanceof CredentialStorageError
          ? error
          : invalidCredentials(error)
      }
    },
    async write(provider, credential) {
      const validated = normalizeCredential(provider, credential)
      try {
        await entry(provider).setPassword(
          JSON.stringify({ version: 1, credential: validated })
        )
      } catch (error) {
        throw classifyKeyringError(error)
      }
    },
    async delete(provider) {
      try {
        await entry(provider).deleteCredential()
      } catch (error) {
        throw classifyKeyringError(error)
      }
    },
  }
}
export function createFileCredentialStore(
  profile: ProviderProfile
): CredentialStore {
  return {
    backend: 'file',
    read: provider => Promise.resolve(profile.credentials[provider]),
    async write(provider, credential) {
      profile.credentials[provider] = normalizeCredential(
        provider,
        credential
      ) as never
    },
    async delete(provider) {
      delete profile.credentials[provider]
    },
  }
}

let defaultAutoBackend: Promise<CredentialBackend> | undefined
const injectedAutoBackends = new WeakMap<
  object,
  Promise<CredentialBackend>
>()
async function probeKeyring(
  dependencies: CredentialStorageDependencies
): Promise<CredentialBackend> {
  const createEntry =
    dependencies.createKeyringEntry ??
    ((service: string, account: string, options?: EntryOptions) =>
      new AsyncEntry(service, account, options))
  try {
    await createEntry(
      KEYRING_SERVICE,
      'probe:v1',
      keyringOptions(dependencies.platform ?? process.platform)
    ).getPassword()
    return 'keyring'
  } catch (error) {
    const classified = classifyKeyringError(error)
    if (classified.code === 'unavailable') return 'file'
    throw classified
  }
}
async function resolveAutoBackend(
  dependencies: CredentialStorageDependencies
): Promise<CredentialBackend> {
  if (
    dependencies.createKeyringEntry !== undefined ||
    dependencies.platform !== undefined
  ) {
    const key = dependencies as object
    let resolution = injectedAutoBackends.get(key)
    if (!resolution) {
      resolution = probeKeyring(dependencies)
      injectedAutoBackends.set(key, resolution)
    }
    return resolution
  }
  defaultAutoBackend ??= probeKeyring(dependencies)
  return defaultAutoBackend
}
async function concreteBackend(
  preference: CredentialStoragePreference,
  dependencies: CredentialStorageDependencies
): Promise<CredentialBackend> {
  return preference === 'auto'
    ? resolveAutoBackend(dependencies)
    : preference
}
export function resolveCredentialStorageBackend(
  preference: CredentialStoragePreference,
  dependencies: CredentialStorageDependencies = {}
): Promise<CredentialBackend> {
  return concreteBackend(preference, dependencies)
}
async function hydrateKeyringCredential(
  profile: ProviderProfile,
  provider: ModelProvider,
  dependencies: CredentialStorageDependencies
): Promise<void> {
  if (profile.credentialBackends[provider] !== 'keyring') return
  const store = createKeyringCredentialStore(dependencies)
  const credential = await store.read(provider)
  if (credential === undefined) throw invalidCredentials()
  profile.credentials[provider] = credential as never
}
export async function readProviderProfile(
  directory = productConfigDir()
): Promise<ProviderProfile> {
  return readProfileDocument(directory)
}
export async function readProviderProfileWithCredential(
  provider: ModelProvider,
  directory = productConfigDir(),
  dependencies: CredentialStorageDependencies = {}
): Promise<ProviderProfile> {
  const profile = await readProviderProfile(directory)
  await hydrateKeyringCredential(profile, provider, dependencies)
  return profile
}
export function readProviderProfileSync(
  directory = productConfigDir()
): ProviderProfile {
  try {
    return parseProfileDocument(
      JSON.parse(readFileSync(providerProfilePath(directory), 'utf8'))
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return emptyProfile()
    if (error instanceof CredentialStorageError) throw error
    throw invalidCredentials(error)
  }
}
export async function writeProviderProfile(
  profile: ProviderProfile,
  directory = productConfigDir()
): Promise<void> {
  await writeProfileDocument(profile, directory)
}
export async function withCredentialLock<T>(
  operation: () => Promise<T>,
  directory = productConfigDir()
): Promise<T> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const lockPath = `${providerProfilePath(directory)}.lock`
  const deadline = Date.now() + LOCK_WAIT_MS
  while (true) {
    try {
      const lock = await open(lockPath, 'wx', 0o600)
      try {
        return await operation()
      } finally {
        await lock.close()
        await unlink(lockPath).catch(() => undefined)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      let age: number
      try {
        age = Date.now() - (await stat(lockPath)).mtimeMs
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === 'ENOENT')
          continue
        throw statError
      }
      if (age > LOCK_STALE_MS) {
        await unlink(lockPath).catch(() => undefined)
        continue
      }
      if (Date.now() >= deadline)
        throw new Error('Timed out waiting for provider credentials.')
      await Bun.sleep(50)
    }
  }
}
export async function updateProviderProfile(
  update: (current: ProviderProfile) => ProviderProfile,
  directory = productConfigDir()
): Promise<ProviderProfile> {
  return withCredentialLock(async () => {
    const profile = update(await readProviderProfile(directory))
    for (const provider of ['gateway', 'codex'] as const) {
      if (profile.credentials[provider])
        profile.credentialBackends[provider] ??= 'file'
    }
    await writeProfileDocument(profile, directory)
    return profile
  }, directory)
}
export async function persistProviderCredential(
  provider: ModelProvider,
  credential: VercelCredential | CodexCredential,
  directory = productConfigDir(),
  dependencies: CredentialStorageDependencies = {}
): Promise<ProviderProfile> {
  return withCredentialLock(async () => {
    const profile = await readProviderProfile(directory)
    const backend = await concreteBackend(
      profile.storagePreference,
      dependencies
    )
    const store =
      backend === 'keyring'
        ? createKeyringCredentialStore(dependencies)
        : createFileCredentialStore(profile)
    await store.write(provider, credential)
    const verified = await store.read(provider)
    if (verified === undefined) throw invalidCredentials()
    profile.credentials[provider] = normalizeCredential(
      provider,
      verified
    ) as never
    profile.credentialBackends[provider] = backend
    profile.activeProvider = provider
    await writeProfileDocument(profile, directory)
    return profile
  }, directory)
}
export async function configureCredentialStorage(
  preference: CredentialStoragePreference,
  directory = productConfigDir(),
  dependencies: CredentialStorageDependencies = {}
): Promise<ProviderProfile> {
  return withCredentialLock(async () => {
    const profile = await readProviderProfile(directory)
    for (const provider of ['gateway', 'codex'] as const)
      await hydrateKeyringCredential(profile, provider, dependencies)
    const destinationBackend = await concreteBackend(
      preference,
      dependencies
    )
    const keyring = createKeyringCredentialStore(dependencies)
    const file = createFileCredentialStore(profile)
    for (const provider of ['gateway', 'codex'] as const) {
      const credential = profile.credentials[provider]
      const sourceBackend = profile.credentialBackends[provider]
      if (
        !credential ||
        !sourceBackend ||
        sourceBackend === destinationBackend
      )
        continue
      const destination = destinationBackend === 'keyring' ? keyring : file
      const existing = await destination.read(provider)
      if (
        existing !== undefined &&
        JSON.stringify(existing) !== JSON.stringify(credential)
      ) {
        throw new CredentialStorageError(
          `A different ${provider} credential already exists in ${destinationBackend}.`,
          'conflict'
        )
      }
      if (existing === undefined)
        await destination.write(provider, credential)
      const verified = await destination.read(provider)
      if (JSON.stringify(verified) !== JSON.stringify(credential))
        throw invalidCredentials()
      profile.credentialBackends[provider] = destinationBackend
      profile.storagePreference = preference
      await writeProfileDocument(profile, directory)
      if (sourceBackend === 'keyring') {
        try {
          await keyring.delete(provider)
        } catch (error) {
          throw new CredentialStorageError(
            `Credential migration succeeded, but the old ${provider} credential could not be removed.`,
            'partial-cleanup',
            { cause: error }
          )
        }
      }
    }
    profile.storagePreference = preference
    await writeProfileDocument(profile, directory)
    return profile
  }, directory)
}
export async function readFreshProviderProfile(
  provider?: ModelProvider,
  directory = productConfigDir(),
  dependencies: ProviderDependencies = {},
  storageDependencies: CredentialStorageDependencies = {}
): Promise<ProviderProfile> {
  const metadata = await readProviderProfile(directory)
  const providerId = provider ?? metadata.activeProvider
  const initial = await readProviderProfileWithCredential(
    providerId,
    directory,
    storageDependencies
  )
  const credential = initial.credentials[providerId]
  const initialAuth = createHarnessProviderRegistry(
    initial.credentials,
    dependencies
  )[providerId].auth
  if (!credential || !initialAuth.needsRefresh(credential as never))
    return initial
  return withCredentialLock(async () => {
    const current = await readProviderProfileWithCredential(
      providerId,
      directory,
      storageDependencies
    )
    const auth = createHarnessProviderRegistry(
      current.credentials,
      dependencies
    )[providerId].auth
    const currentCredential = current.credentials[providerId]
    if (
      !currentCredential ||
      !auth.needsRefresh(currentCredential as never) ||
      !auth.refresh
    )
      return current
    const refreshed = await auth.refresh(currentCredential as never)
    const backend = current.credentialBackends[providerId] ?? 'file'
    const store =
      backend === 'keyring'
        ? createKeyringCredentialStore(storageDependencies)
        : createFileCredentialStore(current)
    await store.write(providerId, refreshed)
    current.credentials[providerId] = refreshed as never
    current.credentialBackends[providerId] = backend
    await writeProfileDocument(current, directory)
    return current
  }, directory)
}
export async function clearProviderCredential(
  provider: ModelProvider,
  directory = productConfigDir(),
  dependencies: CredentialStorageDependencies = {}
): Promise<void> {
  await withCredentialLock(async () => {
    const profile = await readProviderProfile(directory)
    if (profile.credentialBackends[provider] === 'keyring')
      await createKeyringCredentialStore(dependencies).delete(provider)
    delete profile.credentials[provider]
    delete profile.credentialBackends[provider]
    if (provider === profile.activeProvider)
      profile.activeProvider = provider === 'gateway' ? 'codex' : 'gateway'
    await writeProfileDocument(profile, directory)
  }, directory)
}
