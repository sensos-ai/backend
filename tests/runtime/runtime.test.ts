import { describe, expect, test } from 'bun:test'
import { resolveRuntimeIdleTtl } from '../../src/sensos/runtime'

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
