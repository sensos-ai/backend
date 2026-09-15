import { lstat, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { runtimeStatus, stopRuntime } from '@/runtime/client'

const PROFILE_BLOCK_START = '# >>> sensos >>>'
const PROFILE_BLOCK_END = '# <<< sensos <<<'

export async function removeProductData(root: string): Promise<void> {
  await stopRuntime(root)
  const status = await runtimeStatus(root)
  if (status.pid) {
    throw new Error(
      `Refusing to remove product data while runtime ${status.pid} is active`
    )
  }
  await rm(root, { recursive: true, force: true })
}

export function removeSensosProfileBlocks(source: string): string {
  const lines = source.split('\n')
  const output: string[] = []
  let candidateBlock: string[] | undefined
  for (const line of lines) {
    if (!candidateBlock && line.trim() === PROFILE_BLOCK_START) {
      candidateBlock = [line]
      continue
    }
    if (candidateBlock) {
      candidateBlock.push(line)
      if (line.trim() === PROFILE_BLOCK_END) candidateBlock = undefined
      continue
    }
    output.push(line)
  }
  if (candidateBlock) output.push(...candidateBlock)
  return output.join('\n')
}

async function removeManagedShellConfiguration(
  home: string
): Promise<void> {
  const profiles = [
    join(home, '.bashrc'),
    join(home, '.bash_profile'),
    join(home, '.zshrc'),
    join(home, '.zprofile'),
    join(home, '.config', 'fish', 'config.fish'),
  ]
  await Promise.all(
    profiles.map(async profile => {
      let source: string
      try {
        source = await readFile(profile, 'utf8')
      } catch {
        return
      }
      const updated = removeSensosProfileBlocks(source)
      if (updated !== source) await writeFile(profile, updated)
    })
  )
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

async function unlinkBunPackage(
  home: string
): Promise<string | undefined> {
  const packageLink = join(
    home,
    '.bun',
    'install',
    'global',
    'node_modules',
    'sensos'
  )
  if (!(await pathExists(packageLink))) return undefined

  const packageRoot = await realpath(packageLink)
  const bun = Bun.which('bun')
  if (!bun) throw new Error('Could not find Bun to unlink sensos')
  const child = Bun.spawn([bun, 'unlink'], {
    cwd: packageRoot,
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'pipe',
  })
  const exitCode = await child.exited
  if (exitCode !== 0) {
    throw new Error(
      `Failed to unlink sensos: ${await new Response(child.stderr).text()}`
    )
  }
  return packageRoot
}

export async function uninstallSensos(home = homedir()): Promise<void> {
  await removeManagedShellConfiguration(home)
  const linkedPackageRoot = await unlinkBunPackage(home)

  await Promise.all([
    rm(join(home, '.bun', 'bin', 'sensos'), { force: true }),
    rm(join(home, '.bun', 'bin', 'sensos-engine'), { force: true }),
    rm(join(home, '.bun', 'bin', 'sensos-dev'), { force: true }),
    rm(join(home, '.local', 'bin', 'sensos'), { force: true }),
    rm(join(home, '.local', 'bin', 'sensos-engine'), { force: true }),
    ...(linkedPackageRoot
      ? [
          rm(join(linkedPackageRoot, 'dist', 'sensos'), {
            force: true,
          }),
          rm(join(linkedPackageRoot, 'dist', 'sensos-engine'), {
            force: true,
          }),
        ]
      : []),
  ])
}
