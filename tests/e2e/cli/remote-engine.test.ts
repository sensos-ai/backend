import { expect, test } from 'bun:test'
import { startCliE2E } from '../../helpers/cli-e2e'

test('CLI runs a test-model session through an external Rivet runtime', async () => {
  const cli = await startCliE2E(
    'remote-engine',
    { name: 'unused remote gateway', turns: [] },
    { remoteEngine: true, testModel: true }
  )
  try {
    expect(await cli.runtimeStatus()).toContain('0 leases')
    await cli.sendLine('prove the remote actor path')
    await cli.waitForScreen('sequence.', 30_000)
    expect(await cli.runtimeStatus()).toContain('0 leases')
  } finally {
    await cli.stop()
  }
}, 60_000)
