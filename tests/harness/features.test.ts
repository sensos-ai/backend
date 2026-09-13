import { describe, expect, test } from 'bun:test'
import { resolveHarnessFeatures } from '@/chat/harness/features'

describe('resolveHarnessFeatures', () => {
  test('resolves environment flags into a complete transportable value', () => {
    expect(
      resolveHarnessFeatures({}, { SENSOS_USE_TEST_MODEL: '1' })
    ).toEqual({ useMockModel: true })
  })

  test('gives explicit configuration precedence over the environment', () => {
    expect(
      resolveHarnessFeatures(
        { useMockModel: false },
        { SENSOS_USE_TEST_MODEL: '1' }
      )
    ).toEqual({ useMockModel: false })
  })
})
