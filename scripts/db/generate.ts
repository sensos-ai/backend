import { readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

type DrizzleConfig = {
  out?: string
}

type MigrationJournal = {
  entries: Array<{
    idx: number
    tag: string
  }>
}

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../..'
)
const actorsRoot = resolve(repositoryRoot, 'src/runtime/actors')

async function findConfigs(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const configs: string[] = []

  for (const entry of entries) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      configs.push(...(await findConfigs(path)))
    } else if (entry.isFile() && entry.name === 'drizzle.config.ts') {
      configs.push(path)
    }
  }

  return configs
}

async function writeRivetMigrationModule(
  configPath: string
): Promise<void> {
  const imported = (await import(pathToFileURL(configPath).href)) as {
    default?: DrizzleConfig
  }
  const out = imported.default?.out
  if (!out) {
    throw new Error(
      `${relative(repositoryRoot, configPath)} has no out path`
    )
  }

  const outputDirectory = resolve(repositoryRoot, out)
  const journal = JSON.parse(
    await readFile(resolve(outputDirectory, 'meta/_journal.json'), 'utf8')
  ) as MigrationJournal
  const entries = journal.entries.toSorted((a, b) => a.idx - b.idx)

  const imports = entries.map(({ idx, tag }) => {
    const key = `m${idx.toString().padStart(4, '0')}`
    return `import ${key} from './${tag}.sql' with { type: 'text' }`
  })
  const keys = entries.map(
    ({ idx }) => `m${idx.toString().padStart(4, '0')}`
  )
  const module = `${imports.join('\n')}
import journal from './meta/_journal.json' with { type: 'json' }

export default {
  journal,
  migrations: {
${keys.map(key => `    ${key},`).join('\n')}
  },
}
`

  await writeFile(resolve(outputDirectory, 'migrations.js'), module)
  await writeFile(
    resolve(outputDirectory, 'migrations.d.ts'),
    `declare const migrations: {
  journal: unknown
  migrations: Record<string, string>
}

export default migrations
`
  )
}

const configs = (await findConfigs(actorsRoot)).sort()
if (configs.length === 0) {
  throw new Error('No actor Drizzle configurations found')
}

for (const config of configs) {
  const displayPath = relative(repositoryRoot, config)
  console.log(`Generating migrations for ${displayPath}`)

  const child = Bun.spawn(
    ['bunx', 'drizzle-kit', 'generate', '--config', config],
    {
      cwd: repositoryRoot,
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    }
  )
  const exitCode = await child.exited
  if (exitCode !== 0) process.exit(exitCode)

  await writeRivetMigrationModule(config)
}
