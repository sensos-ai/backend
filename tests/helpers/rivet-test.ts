import { onTestFinished } from 'bun:test'
import { setup, type Registry, type RegistryActors } from 'rivetkit'
import { setupTest } from 'rivetkit/test'

type Cleanup = () => unknown | Promise<unknown>

export interface RivetTestContext {
  name: string
  onTestFinished?: typeof onTestFinished
}

export function createTestRegistry<A extends RegistryActors>(use: A) {
  const endpoint = process.env.RIVET_TEST_ENDPOINT
  if (!endpoint) {
    throw new Error(
      'Run Rivet integration tests with bun run test:integration'
    )
  }

  return setup({
    use,
    runtime: 'native',
    endpoint,
    startEngine: false,
    startServices: false,
    noWelcome: true,
    logging: { level: 'silent' },
    shutdown: { disableSignalHandlers: true, gracePeriodMs: 5_000 },
  })
}

export async function createRivetTest<A extends Registry<RegistryActors>>(
  context: RivetTestContext,
  createRegistry: () => A
) {
  const registry = createRegistry()
  const clientCleanups: Cleanup[] = []
  const testContext = {
    onTestFinished(cleanup: Cleanup) {
      clientCleanups.push(cleanup)
    },
  } as Parameters<typeof setupTest>[0]

  const finishTest = context.onTestFinished ?? onTestFinished
  finishTest(async () => {
    const errors: unknown[] = []

    for (const cleanup of clientCleanups) {
      try {
        await cleanup()
      } catch (error) {
        errors.push(error)
      }
    }

    try {
      await registry.shutdown()
    } catch (error) {
      errors.push(error)
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, 'Failed to clean up Rivet test')
    }
  })

  const { client } = await setupTest(testContext, registry)
  const normalizedName = context.name
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
    .slice(0, 48)
  const runId = process.env.RIVET_TEST_RUN_ID ?? 'direct'

  return {
    client,
    actorKey(label: string) {
      const normalizedLabel = label
        .replace(/[^a-zA-Z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .toLowerCase()
        .slice(0, 32)
      return `${runId}-${process.pid}-${normalizedName}-${normalizedLabel}-${crypto.randomUUID()}`
    },
  }
}
