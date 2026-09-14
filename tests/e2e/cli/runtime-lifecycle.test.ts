import { expect, test } from 'bun:test'
import { startCliE2E } from '../../helpers/cli-e2e'

test('runtime startup failure is actionable and leaves no orphan resources', async () => {
  const cli = await startCliE2E(
    'runtime-startup-failure',
    { name: 'unused gateway', turns: [] },
    { failRuntimeStartup: true }
  )
  try {
    const screen = await cli.waitForScreen('● Failed', 30_000)
    expect(screen).toContain('Local runtime supervisor timed out')
    await cli.sendControlC()
    expect(await cli.waitForExit()).toBe(0)
  } finally {
    await cli.stop()
  }
}, 60_000)

test('Ctrl-C exits cleanly and releases the supervised runtime', async () => {
  const cli = await startCliE2E('signal-cleanup', {
    name: 'unused gateway',
    turns: [],
  })
  try {
    await cli.sendControlC()
    expect(await cli.waitForExit()).toBe(0)
    await cli.waitForNoOrphans(20_000)
  } finally {
    await cli.stop()
  }
}, 60_000)
