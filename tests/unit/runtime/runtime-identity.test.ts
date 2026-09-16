import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computeRuntimeSourceIdentity } from '../../../src/runtime/build-identity'
import { isCompatibleRuntime } from '../../../src/runtime/compatibility'
import { RUNTIME_BUILD_ID } from '../../../src/runtime/constants'

describe('runtime identity', () => {
  test('uses build identity as the sole compatibility check', () => {
    expect(RUNTIME_BUILD_ID).toMatch(/^[a-f0-9]{64}$/)
    expect(isCompatibleRuntime({ buildId: RUNTIME_BUILD_ID })).toBe(true)
    expect(isCompatibleRuntime({ buildId: 'stale-build' })).toBe(false)
    expect(isCompatibleRuntime({})).toBe(false)
  })

  test('is deterministic and changes with runtime source inputs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sensos-runtime-id-'))
    await mkdir(join(root, 'src'))
    await mkdir(join(root, 'scripts'))
    await writeFile(
      join(root, 'src', 'runtime.ts'),
      'export const value = 1\n'
    )
    await writeFile(join(root, 'package.json'), '{}\n')
    await writeFile(join(root, 'bun.lock'), 'lock\n')
    await writeFile(join(root, 'scripts', 'build-engine.ts'), 'build\n')

    const initial = computeRuntimeSourceIdentity(root)
    expect(computeRuntimeSourceIdentity(root)).toBe(initial)

    await writeFile(
      join(root, 'src', 'runtime.ts'),
      'export const value = 2\n'
    )
    expect(computeRuntimeSourceIdentity(root)).not.toBe(initial)
  })
})
