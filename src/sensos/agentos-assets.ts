import { getSidecarPath } from '@rivet-dev/agentos-sidecar'
// @ts-expect-error Bun's file loader embeds this package asset at build time.
import coreutilsAsset from '../../node_modules/@agentos-software/coreutils/dist/package.aospkg' with {
  type: 'file',
}
// @ts-expect-error Bun's file loader embeds this package asset at build time.
import diffutilsAsset from '../../node_modules/@agentos-software/diffutils/dist/package.aospkg' with {
  type: 'file',
}
// @ts-expect-error Bun's file loader embeds this package asset at build time.
import findutilsAsset from '../../node_modules/@agentos-software/findutils/dist/package.aospkg' with {
  type: 'file',
}
// @ts-expect-error Bun's file loader embeds this package asset at build time.
import gawkAsset from '../../node_modules/@agentos-software/gawk/dist/package.aospkg' with {
  type: 'file',
}
// @ts-expect-error Bun's file loader embeds this package asset at build time.
import grepAsset from '../../node_modules/@agentos-software/grep/dist/package.aospkg' with {
  type: 'file',
}
// @ts-expect-error Bun's file loader embeds this package asset at build time.
import gzipAsset from '../../node_modules/@agentos-software/gzip/dist/package.aospkg' with {
  type: 'file',
}
// @ts-expect-error Bun's file loader embeds this package asset at build time.
import sedAsset from '../../node_modules/@agentos-software/sed/dist/package.aospkg' with {
  type: 'file',
}
// @ts-expect-error Bun's file loader embeds this package asset at build time.
import tarAsset from '../../node_modules/@agentos-software/tar/dist/package.aospkg' with {
  type: 'file',
}
import { mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  bundledAssetDigest,
  materializeVersionedAsset,
} from './runtime-assets'

// The production build rewrites this resolver to a Bun file-loader import for
// the selected release target. Source mode resolves the current host package.
const sidecarAsset = getSidecarPath()

export type AgentOsSoftwareRef = { packagePath: string }

export const AGENTOS_SOFTWARE_ENV = 'SENSOS_AGENTOS_SOFTWARE_PATHS'

type EmbeddedAsset = {
  name: string
  sourcePath: string
}

const softwareAssets: EmbeddedAsset[] = [
  { name: 'coreutils', sourcePath: coreutilsAsset },
  { name: 'sed', sourcePath: sedAsset },
  { name: 'grep', sourcePath: grepAsset },
  { name: 'gawk', sourcePath: gawkAsset },
  { name: 'findutils', sourcePath: findutilsAsset },
  { name: 'diffutils', sourcePath: diffutilsAsset },
  { name: 'tar', sourcePath: tarAsset },
  { name: 'gzip', sourcePath: gzipAsset },
]

let configuredSoftware: AgentOsSoftwareRef[] = softwareAssets.map(
  asset => ({
    packagePath: asset.sourcePath,
  })
)

function isCompiledAsset(path: string): boolean {
  return path.startsWith('/$bunfs/')
}

async function materializeAsset(
  runtimeDir: string,
  asset: EmbeddedAsset,
  executable = false
): Promise<string> {
  const hash = bundledAssetDigest(asset.name)
  if (!hash) throw new Error(`Compiled ${asset.name} digest is missing`)
  return materializeVersionedAsset({
    runtimeDir,
    name: asset.name,
    sourcePath: asset.sourcePath,
    digest: hash,
    suffix: executable ? '' : '.aospkg',
    executable,
  })
}

/**
 * Copies Bun-embedded AgentOS assets to real filesystem paths. The native
 * sidecar cannot execute, and cannot open software bundles, from `/$bunfs`.
 */
export async function prepareAgentOsAssets(root: string): Promise<void> {
  if (!isCompiledAsset(sidecarAsset)) {
    configuredSoftware = softwareAssets.map(asset => ({
      packagePath: asset.sourcePath,
    }))
    process.env[AGENTOS_SOFTWARE_ENV] = JSON.stringify(
      configuredSoftware.map(item => item.packagePath)
    )
    return
  }

  const runtimeDir = join(root, 'runtime', 'agentos')
  try {
    await mkdir(runtimeDir, { recursive: true, mode: 0o700 })
    const sidecarPath = await materializeAsset(
      runtimeDir,
      { name: 'agentos-sidecar', sourcePath: sidecarAsset },
      true
    )
    const packagePaths = await Promise.all(
      softwareAssets.map(asset => materializeAsset(runtimeDir, asset))
    )

    const sidecarStat = await stat(sidecarPath)
    if (!sidecarStat.isFile()) {
      throw new Error(`materialized sidecar is not a file: ${sidecarPath}`)
    }

    process.env.AGENTOS_SIDECAR_BIN = sidecarPath
    configuredSoftware = packagePaths.map(packagePath => ({ packagePath }))
    process.env[AGENTOS_SOFTWARE_ENV] = JSON.stringify(packagePaths)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Failed to prepare bundled AgentOS runtime assets in ${runtimeDir}: ${detail}`,
      { cause: error }
    )
  }
}

/** Explicit refs used with `defaultSoftware: false` in `AgentOs.create`. */
export function getAgentOsSoftware(): AgentOsSoftwareRef[] {
  return configuredSoftware
}
