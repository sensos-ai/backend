import { stat, writeFile } from 'node:fs/promises'
import { isolationTestActor } from '../fixtures/rivet/isolation-test-actor'
import { createRivetTest, createTestRegistry } from './rivet-test'
import { waitForValue } from './wait'

const [value, readyPath, peerReadyPath] = process.argv.slice(2)
if (!value || !readyPath || !peerReadyPath) {
  throw new Error('Isolation worker arguments are required')
}

let finishTest: (() => unknown | Promise<unknown>) | undefined
const fixture = await createRivetTest(
  {
    name: `isolation worker ${value}`,
    onTestFinished(cleanup) {
      finishTest = cleanup as () => unknown | Promise<unknown>
    },
  },
  () => createTestRegistry({ isolationTestActor })
)
const key = fixture.trackedActorKey(
  'isolationTestActor',
  'same-logical-suffix'
)
const handle = fixture.client.isolationTestActor.getOrCreate([key])
await handle.setValue(value)
await writeFile(readyPath, '')
await waitForValue(
  () =>
    stat(peerReadyPath)
      .then(() => true)
      .catch(() => false),
  Boolean,
  { description: 'peer isolation actor to become ready' }
)

console.log(
  `RIVET_ISOLATION_RESULT ${JSON.stringify({
    key,
    value: await handle.getValue(),
  })}`
)
try {
  await finishTest?.()
  process.exit(0)
} catch (error) {
  console.error(error)
  process.exit(1)
}
