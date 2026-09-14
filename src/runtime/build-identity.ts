import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'

const SOURCE_DIRECTORIES = ['src'] as const
const SOURCE_FILES = [
  'package.json',
  'bun.lock',
  'scripts/build-sensos.ts',
] as const

function collectFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap(entry => {
      const path = resolve(directory, entry.name)
      return entry.isDirectory() ? collectFiles(path) : [path]
    })
    .sort()
}

export function computeRuntimeSourceIdentity(projectRoot: string): string {
  const files = [
    ...SOURCE_DIRECTORIES.flatMap(directory =>
      collectFiles(resolve(projectRoot, directory))
    ),
    ...SOURCE_FILES.map(file => resolve(projectRoot, file)),
  ].sort()
  const hash = createHash('sha256')

  for (const file of files) {
    hash.update(relative(projectRoot, file))
    hash.update('\0')
    hash.update(readFileSync(file))
    hash.update('\0')
  }

  return hash.digest('hex')
}
