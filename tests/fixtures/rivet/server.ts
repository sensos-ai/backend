import { rivetTestRegistry } from './registry'

async function waitUntilReady(): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const response = await rivetTestRegistry.routes
      .health()
      .catch(() => null)
    if (response?.ok) return
    await Bun.sleep(100)
  }
  throw new Error('Timed out starting the Rivet integration fixture')
}

let stopping = false
async function shutdown(exitCode: number): Promise<never> {
  if (stopping) await new Promise(() => {})
  stopping = true
  await rivetTestRegistry.shutdown()
  process.exit(exitCode)
}

process.once('SIGINT', () => void shutdown(130))
process.once('SIGTERM', () => void shutdown(0))

rivetTestRegistry.start()
await waitUntilReady()
console.log('RIVET_TEST_FIXTURE_READY')
await new Promise(() => {})
