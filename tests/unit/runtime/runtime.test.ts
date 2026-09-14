import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  RUNTIME_BUILD_ID,
  RUNTIME_PROTOCOL_VERSION,
  isCompatibleRuntime,
  resolveRuntimeIdleTtl,
} from '../../../src/runtime'
import { computeRuntimeSourceIdentity } from '../../../src/runtime/build-identity'

describe('runtime idle TTL', () => {
  test('uses an intentional bounded configuration', () => {
    expect(resolveRuntimeIdleTtl(undefined)).toBe(300_000)
    expect(resolveRuntimeIdleTtl('0')).toBe(0)
    expect(resolveRuntimeIdleTtl('1500')).toBe(1500)
    expect(() => resolveRuntimeIdleTtl('nope')).toThrow(
      'must be a non-negative integer'
    )
    expect(() => resolveRuntimeIdleTtl('-1')).toThrow()
    expect(() => resolveRuntimeIdleTtl('86400001')).toThrow(
      'must be between'
    )
  })
})

describe('runtime identity', () => {
  test('separates protocol compatibility from build identity', () => {
    expect(RUNTIME_PROTOCOL_VERSION).toBe(
      process.env.SENSOS_RUNTIME_PROTOCOL_VERSION?.trim() || '1'
    )
    expect(RUNTIME_BUILD_ID).toMatch(/^[a-f0-9]{64}$/)
  })

  test('requires both protocol and build identity to match', () => {
    expect(
      isCompatibleRuntime({
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        buildId: RUNTIME_BUILD_ID,
      })
    ).toBe(true)
    expect(
      isCompatibleRuntime({
        protocolVersion: `${RUNTIME_PROTOCOL_VERSION}-next`,
        buildId: RUNTIME_BUILD_ID,
      })
    ).toBe(false)
    expect(
      isCompatibleRuntime({
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        buildId: 'stale-build',
      })
    ).toBe(false)
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
    await writeFile(join(root, 'scripts', 'build-sensos.ts'), 'build\n')

    const initial = computeRuntimeSourceIdentity(root)
    expect(computeRuntimeSourceIdentity(root)).toBe(initial)

    await writeFile(
      join(root, 'src', 'runtime.ts'),
      'export const value = 2\n'
    )
    expect(computeRuntimeSourceIdentity(root)).not.toBe(initial)
  })
})
