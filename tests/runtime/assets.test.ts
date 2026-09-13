import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { materializeVersionedAsset } from '../../src/sensos/runtime-assets'

describe('runtime asset materialization', () => {
  test('reuses a verified content-addressed asset and repairs corruption', async () => {
    const root = join(
      process.env.RIVETKIT_STORAGE_PATH ?? '/tmp',
      `asset-${process.pid}-${Date.now()}`
    )
    const source = join(root, 'source')
    const runtimeDir = join(root, 'runtime')
    await mkdir(root, { recursive: true })
    await writeFile(source, 'trusted bytes')
    const digest = createHash('sha256')
      .update('trusted bytes')
      .digest('hex')
    const options = {
      runtimeDir,
      name: 'fixture',
      sourcePath: source,
      digest,
      executable: true,
    }

    const destination = await materializeVersionedAsset(options)
    const firstMtime = (await stat(destination)).mtimeMs
    expect(await readFile(destination, 'utf8')).toBe('trusted bytes')

    await chmod(destination, 0o600)
    expect(await materializeVersionedAsset(options)).toBe(destination)
    expect((await stat(destination)).mtimeMs).toBe(firstMtime)
    expect((await stat(destination)).mode & 0o700).toBe(0o700)

    await writeFile(destination, 'corrupt')
    await materializeVersionedAsset(options)
    expect(await readFile(destination, 'utf8')).toBe('trusted bytes')
  })

  test('rejects a source that does not match its manifest digest', async () => {
    const root = join(
      process.env.RIVETKIT_STORAGE_PATH ?? '/tmp',
      `asset-invalid-${process.pid}-${Date.now()}`
    )
    await mkdir(root, { recursive: true })
    const source = join(root, 'source')
    await writeFile(source, 'unexpected')

    expect(
      materializeVersionedAsset({
        runtimeDir: join(root, 'runtime'),
        name: 'fixture',
        sourcePath: source,
        digest: '0'.repeat(64),
      })
    ).rejects.toThrow('failed integrity verification')
  })
})
