import { describe, expect, test } from 'bun:test'
import {
  REGISTRY_ENDPOINT_ENV,
  resolveRivetEngineTarget,
  STREAMS_URL_ENV,
} from '@/runtime/engine-transport'

describe('Rivet engine target', () => {
  test('requires remote configuration by default', () => {
    expect(() => resolveRivetEngineTarget({}, {})).toThrow(
      'Remote engine is not configured'
    )
  })

  test('selects the separate local engine explicitly', () => {
    expect(resolveRivetEngineTarget({ localEngine: true }, {})).toEqual({
      kind: 'local',
    })
  })

  test('resolves an explicit remote engine and streams service', () => {
    expect(
      resolveRivetEngineTarget(
        {},
        {
          [REGISTRY_ENDPOINT_ENV]: 'https://engine.example.test/',
          [STREAMS_URL_ENV]: 'https://streams.example.test/',
        }
      )
    ).toEqual({
      kind: 'remote',
      endpoint: 'https://engine.example.test',
      streamsEndpoint: 'https://streams.example.test',
    })
  })

  test('rejects a partial remote configuration before runtime startup', () => {
    expect(() =>
      resolveRivetEngineTarget(
        {},
        { [REGISTRY_ENDPOINT_ENV]: 'https://engine.example.test' }
      )
    ).toThrow('requires both')
  })
})
