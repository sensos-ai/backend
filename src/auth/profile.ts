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

type LegacyVercelCredential = Omit<
  Extract<VercelCredential, { kind: 'oauth' }>,
  'kind'
>
type LegacyCodexCredential = Omit<CodexCredential, 'kind'>

export type ProviderProfile = {
  version: 2
  activeProvider: ModelProvider
  credentials: ProviderCredentials
}

export type { CodexCredential, ModelProvider, VercelCredential }

export function providerProfilePath(
  directory = productConfigDir()
): string {
  return join(directory, 'auth.json')
}

function parseProviderProfile(value: unknown): ProviderProfile {
  if (!value || typeof value !== 'object') {
    throw new Error('Sensos credentials are invalid. Run `sensos login`.')
  }
  const candidate = value as {
    version?: unknown
    activeProvider?: unknown
    credentials?: {
      gateway?: VercelCredential | LegacyVercelCredential
      codex?: CodexCredential | LegacyCodexCredential
    }
    vercel?: LegacyVercelCredential
    codex?: LegacyCodexCredential
  }
  if (
    candidate.activeProvider !== 'gateway' &&
    candidate.activeProvider !== 'codex'
  ) {
    throw new Error('Sensos credentials are invalid. Run `sensos login`.')
  }
  if (candidate.version === 2) {
    const gateway = candidate.credentials?.gateway
    const codex = candidate.credentials?.codex
    return {
      version: 2,
      activeProvider: candidate.activeProvider,
      credentials: {
        ...(gateway
          ? {
              gateway:
                'kind' in gateway
                  ? gateway
                  : { ...gateway, kind: 'oauth' as const },
            }
          : {}),
        ...(codex
          ? {
              codex:
                'kind' in codex
                  ? codex
                  : { ...codex, kind: 'oauth' as const },
            }
          : {}),
      },
    }
  }
  if (candidate.version === 1) {
    return {
      version: 2,
      activeProvider: candidate.activeProvider,
      credentials: {
        ...(candidate.vercel
          ? { gateway: { ...candidate.vercel, kind: 'oauth' as const } }
          : {}),
        ...(candidate.codex
          ? { codex: { ...candidate.codex, kind: 'oauth' as const } }
          : {}),
      },
    }
  }
  throw new Error('Sensos credentials are invalid. Run `sensos login`.')
}

export async function readProviderProfile(
  directory = productConfigDir()
): Promise<ProviderProfile> {
  try {
    return parseProviderProfile(
      JSON.parse(await readFile(providerProfilePath(directory), 'utf8'))
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 2, activeProvider: 'gateway', credentials: {} }
    }
    throw error
  }
}

export function readProviderProfileSync(
  directory = productConfigDir()
): ProviderProfile {
  try {
    return parseProviderProfile(
      JSON.parse(readFileSync(providerProfilePath(directory), 'utf8'))
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 2, activeProvider: 'gateway', credentials: {} }
    }
    throw error
  }
}

export async function writeProviderProfile(
  profile: ProviderProfile,
  directory = productConfigDir()
): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  const path = providerProfilePath(directory)
  const temporaryPath = `${path}.${process.pid}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(profile, null, 2)}\n`, {
    mode: 0o600,
  })
  await chmod(temporaryPath, 0o600)
  await rename(temporaryPath, path)
  await chmod(path, 0o600)
}

export async function updateProviderProfile(
  update: (current: ProviderProfile) => ProviderProfile,
  directory = productConfigDir()
): Promise<ProviderProfile> {
  const profile = update(await readProviderProfile(directory))
  await writeProviderProfile(profile, directory)
  return profile
}

const LOCK_STALE_MS = 30_000
const LOCK_WAIT_MS = 5_000

async function withProviderProfileLock<T>(
  operation: () => Promise<T>,
  directory: string
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
      if (Date.now() >= deadline) {
        throw new Error(
          'Timed out waiting to refresh provider credentials.'
        )
      }
      await Bun.sleep(50)
    }
  }
}

export async function readFreshProviderProfile(
  provider?: ModelProvider,
  directory = productConfigDir(),
  dependencies: ProviderDependencies = {}
): Promise<ProviderProfile> {
  const initial = await readProviderProfile(directory)
  const providerId = provider ?? initial.activeProvider
  const credential = initial.credentials[providerId]
  const initialHarness = createHarnessProviderRegistry(
    initial.credentials,
    dependencies
  )
  const initialAuth = initialHarness[providerId].auth
  if (!credential || !initialAuth.needsRefresh(credential as never)) {
    return initial
  }

  return withProviderProfileLock(async () => {
    const current = await readProviderProfile(directory)
    const harness = createHarnessProviderRegistry(
      current.credentials,
      dependencies
    )
    if (providerId === 'gateway') {
      const currentCredential = current.credentials.gateway
      if (
        !currentCredential ||
        !harness.gateway.auth.needsRefresh(currentCredential)
      ) {
        return current
      }
      const refresh = harness.gateway.auth.refresh
      if (!refresh) return current
      const refreshed = await refresh(currentCredential)
      const next = {
        ...current,
        credentials: { ...current.credentials, gateway: refreshed },
      }
      await writeProviderProfile(next, directory)
      return next
    }

    const currentCredential = current.credentials.codex
    if (
      !currentCredential ||
      !harness.codex.auth.needsRefresh(currentCredential)
    ) {
      return current
    }
    const refresh = harness.codex.auth.refresh
    if (!refresh) return current
    const refreshed = await refresh(currentCredential)
    const next = {
      ...current,
      credentials: { ...current.credentials, codex: refreshed },
    }
    await writeProviderProfile(next, directory)
    return next
  }, directory)
}

export async function clearProviderCredential(
  provider: ModelProvider,
  directory = productConfigDir()
): Promise<void> {
  const profile = await readProviderProfile(directory)
  const next: ProviderProfile = {
    ...profile,
    credentials: { ...profile.credentials, [provider]: undefined },
  }
  if (provider === profile.activeProvider) {
    next.activeProvider = provider === 'gateway' ? 'codex' : 'gateway'
  }
  if (!next.credentials.gateway && !next.credentials.codex) {
    try {
      await unlink(providerProfilePath(directory))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return
  }
  await writeProviderProfile(next, directory)
}
