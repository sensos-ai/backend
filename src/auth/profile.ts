import {
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { productConfigDir } from '@/config/paths'
import type {
  ModelProvider,
  ProviderCredentials,
} from '@/chat/harness/providers/registry'
import type { VercelCredential } from '@/chat/harness/providers/gateway'
import type { CodexCredential } from '@/chat/harness/providers/openai'

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
    credentials?: ProviderCredentials
    vercel?: VercelCredential
    codex?: CodexCredential
  }
  if (
    candidate.activeProvider !== 'gateway' &&
    candidate.activeProvider !== 'codex'
  ) {
    throw new Error('Sensos credentials are invalid. Run `sensos login`.')
  }
  if (candidate.version === 2) {
    return {
      version: 2,
      activeProvider: candidate.activeProvider,
      credentials: candidate.credentials ?? {},
    }
  }
  if (candidate.version === 1) {
    return {
      version: 2,
      activeProvider: candidate.activeProvider,
      credentials: {
        ...(candidate.vercel ? { gateway: candidate.vercel } : {}),
        ...(candidate.codex ? { codex: candidate.codex } : {}),
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
