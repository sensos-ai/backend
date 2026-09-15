import type { BunPlugin } from 'bun'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { computeRuntimeSourceIdentity } from '../src/runtime/build-identity'

type ReleaseTarget =
  | 'darwin-arm64'
  | 'darwin-x64'
  | 'linux-arm64'
  | 'linux-x64'

const targetPackages: Record<
  ReleaseTarget,
  { engine: string; services: string; sidecar: string; keyring: string }
> = {
  'darwin-arm64': {
    engine: '@rivetkit/engine-cli-darwin-arm64/rivet-engine',
    services: '@rivet-dev/services-darwin-arm64/rivet-services',
    sidecar: '@rivet-dev/agentos-sidecar-darwin-arm64/agentos-sidecar',
    keyring: '@napi-rs/keyring-darwin-arm64/keyring.darwin-arm64.node',
  },
  'darwin-x64': {
    engine: '@rivetkit/engine-cli-darwin-x64/rivet-engine',
    services: '@rivet-dev/services-darwin-x64/rivet-services',
    sidecar: '@rivet-dev/agentos-sidecar-darwin-x64/agentos-sidecar',
    keyring: '@napi-rs/keyring-darwin-x64/keyring.darwin-x64.node',
  },
  'linux-arm64': {
    engine: '@rivetkit/engine-cli-linux-arm64-musl/rivet-engine',
    services: '@rivet-dev/services-linux-arm64-musl/rivet-services',
    sidecar: '@rivet-dev/agentos-sidecar-linux-arm64-gnu/agentos-sidecar',
    keyring:
      '@napi-rs/keyring-linux-arm64-musl/keyring.linux-arm64-musl.node',
  },
  'linux-x64': {
    engine: '@rivetkit/engine-cli-linux-x64-musl/rivet-engine',
    services: '@rivet-dev/services-linux-x64-musl/rivet-services',
    sidecar: '@rivet-dev/agentos-sidecar-linux-x64-gnu/agentos-sidecar',
    keyring: '@napi-rs/keyring-linux-x64-musl/keyring.linux-x64-musl.node',
  },
}

const requestedTarget = `${process.platform}-${process.arch}`
if (!(requestedTarget in targetPackages)) {
  throw new Error(
    `Unsupported Sensos build target ${requestedTarget}. Supported targets: ${Object.keys(targetPackages).join(', ')}`
  )
}
const releaseTarget = requestedTarget as ReleaseTarget
const nativeAssets = targetPackages[releaseTarget]

const requiredNativeAssets = [
  '@napi-rs/keyring/package.json',
  ...Object.values(nativeAssets),
]
for (const asset of requiredNativeAssets) {
  if (!(await Bun.file(resolve(`node_modules/${asset}`)).exists())) {
    throw new Error(
      `Sensos cannot build ${releaseTarget}: required native asset ${asset} is not installed. Install optional dependencies on the target platform before building.`
    )
  }
}

const assetPaths = {
  'rivet-engine': `node_modules/${nativeAssets.engine}`,
  'rivet-services': `node_modules/${nativeAssets.services}`,
  'agentos-sidecar': `node_modules/${nativeAssets.sidecar}`,
  coreutils:
    'node_modules/@agentos-software/coreutils/dist/package.aospkg',
  sed: 'node_modules/@agentos-software/sed/dist/package.aospkg',
  grep: 'node_modules/@agentos-software/grep/dist/package.aospkg',
  gawk: 'node_modules/@agentos-software/gawk/dist/package.aospkg',
  findutils:
    'node_modules/@agentos-software/findutils/dist/package.aospkg',
  diffutils:
    'node_modules/@agentos-software/diffutils/dist/package.aospkg',
  tar: 'node_modules/@agentos-software/tar/dist/package.aospkg',
  gzip: 'node_modules/@agentos-software/gzip/dist/package.aospkg',
} as const

const assetManifest = Object.fromEntries(
  await Promise.all(
    Object.entries(assetPaths).map(async ([name, path]) => {
      const bytes = await Bun.file(resolve(path)).arrayBuffer()
      const digest = createHash('sha256')
        .update(new Uint8Array(bytes))
        .digest('hex')
      return [name, digest]
    })
  )
)

const runtimeBuildId = createHash('sha256')
  .update(computeRuntimeSourceIdentity(resolve('.')))
  .update('\0')
  .update(releaseTarget)
  .update('\0')
  .update(JSON.stringify(assetManifest))
  .digest('hex')

const makeNativeRuntimeBundlable: BunPlugin = {
  name: 'bundle-rivetkit-native-runtime',
  setup(build) {
    build.onLoad(
      { filter: /src\/runtime\/assets\.ts$/ },
      async ({ path }) => {
        const source = await Bun.file(path).text()
        return {
          contents: source
            .replace(
              "import { getEnginePath } from '@rivetkit/engine-cli'",
              `import engineAsset from ${JSON.stringify(resolve(`node_modules/${nativeAssets.engine}`))} with { type: 'file' }`
            )
            .replace('const engineAsset = getEnginePath()', '')
            .replace(
              "import { getServicesPath } from '@rivet-dev/services'",
              `import servicesAsset from ${JSON.stringify(resolve(`node_modules/${nativeAssets.services}`))} with { type: 'file' }`
            )
            .replace('const servicesAsset = getServicesPath()', ''),
          loader: 'ts',
        }
      }
    )
    build.onLoad(
      { filter: /src\/runtime\/agentos-assets\.ts$/ },
      async ({ path }) => {
        const source = await Bun.file(path).text()
        return {
          contents: source
            .replace(
              "import { getSidecarPath } from '@rivet-dev/agentos-sidecar'",
              `import sidecarAsset from ${JSON.stringify(resolve(`node_modules/${nativeAssets.sidecar}`))} with { type: 'file' }`
            )
            .replace('const sidecarAsset = getSidecarPath()', ''),
          loader: 'ts',
        }
      }
    )
    build.onLoad(
      { filter: /rivetkit\/dist\/tsup\/mod\.js$/ },
      async ({ path }) => {
        const source = await Bun.file(path).text()
        const rewritten = source
          .replaceAll(
            'import(["@rivetkit", "rivetkit-napi"].join("/"))',
            'import("@rivetkit/rivetkit-napi")'
          )
          .replaceAll(
            'import(["@rivetkit", "engine-cli"].join("/"))',
            'import("@rivetkit/engine-cli")'
          )
          .replaceAll(
            'import(["@rivet-dev", "services"].join("/"))',
            'import("@rivet-dev/services")'
          )

        if (rewritten === source) {
          throw new Error(
            "Could not locate RivetKit's opaque native-runtime import"
          )
        }
        return { contents: rewritten, loader: 'js' }
      }
    )
  },
}

const result = await Bun.build({
  entrypoints: ['src/cli/bootstrap.ts'],
  plugins: [makeNativeRuntimeBundlable],
  minify: true,
  sourcemap: 'linked',
  define: {
    __SENSOS_ASSET_MANIFEST__: JSON.stringify(assetManifest),
    __SENSOS_RUNTIME_BUILD_ID__: JSON.stringify(runtimeBuildId),
  },
  compile: {
    outfile: 'dist/sensos',
  },
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
