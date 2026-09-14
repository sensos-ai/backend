import { createHash } from 'node:crypto'
import { chmod, mkdir, open, rename, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { getEnginePath } from '@rivetkit/engine-cli'
import { getServicesPath } from '@rivet-dev/services'

// The production build rewrites this resolver to a Bun file-loader import for
// the selected release target. Source mode resolves the current host package.
const engineAsset = getEnginePath()
const servicesAsset = getServicesPath()

declare const __SENSOS_ASSET_MANIFEST__: Record<string, string>

let temporaryAssetSequence = 0

export function bundledAssetDigest(name: string): string | undefined {
  if (typeof __SENSOS_ASSET_MANIFEST__ === 'undefined') return undefined
  return __SENSOS_ASSET_MANIFEST__[name]
}

export async function materializeVersionedAsset(options: {
  runtimeDir: string
  name: string
  sourcePath: string
  digest: string
  suffix?: string
  executable?: boolean
}): Promise<string> {
  if (!/^[a-f0-9]{64}$/.test(options.digest)) {
    throw new Error(`Invalid SHA-256 digest for ${options.name}`)
  }
  const destination = join(
    options.runtimeDir,
    `${options.name}-${options.digest}${options.suffix ?? ''}`
  )
  try {
    const current = await stat(destination)
    if (
      current.isFile() &&
      (await digestFile(destination)) === options.digest
    ) {
      if (options.executable && (current.mode & 0o700) !== 0o700) {
        await chmod(destination, 0o700)
      }
      return destination
    }
  } catch {
    // The content-addressed asset has not been extracted yet.
  }

  await mkdir(options.runtimeDir, { recursive: true, mode: 0o700 })
  const temporary = join(
    options.runtimeDir,
    `.${options.name}-${process.pid}-${Date.now()}-${temporaryAssetSequence++}.tmp`
  )
  try {
    const bytes = new Uint8Array(
      await Bun.file(options.sourcePath).arrayBuffer()
    )
    const sourceDigest = createHash('sha256').update(bytes).digest('hex')
    if (sourceDigest !== options.digest) {
      throw new Error(
        `Bundled ${options.name} failed integrity verification: expected ${options.digest}, received ${sourceDigest}`
      )
    }
    const file = await open(
      temporary,
      'wx',
      options.executable ? 0o700 : 0o600
    )
    try {
      await file.writeFile(bytes)
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temporary, destination).catch(async error => {
      try {
        const winner = await stat(destination)
        if (winner.isFile()) return
      } catch {
        // Preserve the original atomic-rename error.
      }
      throw error
    })
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
  return destination
}

async function digestFile(path: string): Promise<string> {
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer())
  return createHash('sha256').update(bytes).digest('hex')
}

export async function prepareRivetEngine(root: string): Promise<string> {
  if (!engineAsset.startsWith('/$bunfs/')) return engineAsset
  const digest = bundledAssetDigest('rivet-engine')
  if (!digest) throw new Error('Compiled Rivet asset digest is missing')
  return materializeVersionedAsset({
    runtimeDir: join(root, 'runtime', 'engine'),
    name: 'sensos-engine',
    sourcePath: engineAsset,
    digest,
    executable: true,
  })
}

export async function prepareRivetServices(root: string): Promise<string> {
  if (!servicesAsset.startsWith('/$bunfs/')) return servicesAsset
  const digest = bundledAssetDigest('rivet-services')
  if (!digest)
    throw new Error('Compiled Rivet Services asset digest is missing')
  return materializeVersionedAsset({
    runtimeDir: join(root, 'runtime', 'services'),
    name: 'rivet-services',
    sourcePath: servicesAsset,
    digest,
    executable: true,
  })
}
