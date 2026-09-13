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
import { productConfigDir } from './paths'

export type ModelProvider = 'gateway' | 'codex'

export type VercelCredential = {
  accessToken: string
  refreshToken?: string
  expiresAt: number
  teamId?: string
}

export type CodexCredential = {
  accessToken: string
  refreshToken: string
  expiresAt: number
  accountId: string
}

export type ProviderProfile = {
  version: 1
  activeProvider: ModelProvider
  vercel?: VercelCredential
  codex?: CodexCredential
}

export function providerProfilePath(
  directory = productConfigDir()
): string {
  return join(directory, 'auth.json')
}

function parseProviderProfile(value: unknown): ProviderProfile {
  if (
    !value ||
    typeof value !== 'object' ||
    (value as Partial<ProviderProfile>).version !== 1 ||
    ((value as Partial<ProviderProfile>).activeProvider !== 'gateway' &&
      (value as Partial<ProviderProfile>).activeProvider !== 'codex')
  ) {
    throw new Error('Sensos credentials are invalid. Run `sensos login`.')
  }
  return value as ProviderProfile
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
      return { version: 1, activeProvider: 'gateway' }
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
      return { version: 1, activeProvider: 'gateway' }
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
  provider: 'vercel' | 'codex',
  directory = productConfigDir()
): Promise<void> {
  const profile = await readProviderProfile(directory)
  const next: ProviderProfile = {
    ...profile,
    ...(provider === 'vercel'
      ? { vercel: undefined }
      : { codex: undefined }),
  }
  if (
    (provider === 'vercel' && profile.activeProvider === 'gateway') ||
    (provider === 'codex' && profile.activeProvider === 'codex')
  ) {
    next.activeProvider = provider === 'vercel' ? 'codex' : 'gateway'
  }
  if (!next.vercel && !next.codex) {
    try {
      await unlink(providerProfilePath(directory))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return
  }
  await writeProviderProfile(next, directory)
}
