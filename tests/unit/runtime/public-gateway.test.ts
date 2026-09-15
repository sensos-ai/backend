import { describe, expect, test } from 'bun:test'
import { resolvePublicGatewayRoute } from '@/runtime/public-gateway'

const options = {
  engineEndpoint: 'http://127.0.0.1:6420',
  streamsEndpoint: 'http://127.0.0.1:6422',
}

describe('public Rivet gateway routing', () => {
  test('strips the public registry prefix before reaching the engine', () => {
    expect(
      resolvePublicGatewayRoute(
        'https://sensos.example/api/rivet/actors/session/connect?key=one',
        options
      )
    ).toEqual({
      target: new URL(
        'http://127.0.0.1:6420/actors/session/connect?key=one'
      ),
      websocket: true,
    })
  })

  test('preserves the native durable-streams service path', () => {
    expect(
      resolvePublicGatewayRoute(
        'https://sensos.example/durable-streams/v1/stream/sensos/runs/run_1?offset=-1',
        options
      )
    ).toEqual({
      target: new URL(
        'http://127.0.0.1:6422/durable-streams/v1/stream/sensos/runs/run_1?offset=-1'
      ),
      websocket: false,
    })
  })

  test('leaves application routes local', () => {
    expect(
      resolvePublicGatewayRoute('https://sensos.example/health', options)
    ).toBeUndefined()
  })
})
