import { describe, expect, test } from 'bun:test'
import app from '@/app'

describe('protocol discovery', () => {
  test('advertises the preferred and supported wire revisions', async () => {
    const response = await app.request('/api/protocol')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      protocolVersion: 1,
      supportedProtocolVersions: [1],
    })
  })
})
