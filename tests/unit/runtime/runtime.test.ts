import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  RUNTIME_BUILD_ID,
  RUNTIME_PROTOCOL_VERSION,
  isCompatibleRuntime,
  resolveRuntimeIdleTtl,
  shouldDeferRuntimeIdleShutdown,
} from '../../../src/runtime'
import {
  onRuntimeActivityChange,
  releaseRuntimeActivity,
  retainRuntimeActivity,
  runtimeActivityCount,
} from '../../../src/runtime/activity'
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

  test('defers shutdown through active and queued work until the final entry settles', () => {
    const activeKey = `active-${crypto.randomUUID()}`
    const queuedKey = `queued-${crypto.randomUUID()}`
    const decisions: boolean[] = []
    const removeListener = onRuntimeActivityChange(activityCount => {
      decisions.push(
        shouldDeferRuntimeIdleShutdown({
          leaseCount: 0,
          activityCount,
          shuttingDown: false,
        })
      )
    })

    try {
      retainRuntimeActivity(activeKey)
      retainRuntimeActivity(queuedKey)
      releaseRuntimeActivity(activeKey)
      expect(runtimeActivityCount()).toBeGreaterThan(0)
      releaseRuntimeActivity(queuedKey)

      expect(decisions).toEqual([true, true, true, false])
    } finally {
      releaseRuntimeActivity(activeKey)
      releaseRuntimeActivity(queuedKey)
      removeListener()
    }
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
