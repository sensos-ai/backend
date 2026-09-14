import { onTestFinished } from 'bun:test'
import { setup, type Registry, type RegistryActors } from 'rivetkit'
import { setupTest } from 'rivetkit/test'

type Cleanup = () => unknown | Promise<unknown>
type TrackedActor = { name: string; key: string }

async function withCleanupTimeout(
  operation: string,
  cleanup: () => unknown | Promise<unknown>
) {
  const timeoutMs = 5_000
  await Promise.race([
    Promise.resolve().then(cleanup),
    Bun.sleep(timeoutMs).then(() => {
      throw new Error(`${operation} did not finish within ${timeoutMs}ms`)
    }),
  ])
}

let registryStartupTail = Promise.resolve()

async function serializeRegistryStartup<T>(start: () => Promise<T>) {
  const previousStartup = registryStartupTail
  let releaseStartup = () => {}
  registryStartupTail = new Promise<void>(resolve => {
    releaseStartup = resolve
  })
  await previousStartup
  try {
    return await start()
  } finally {
    releaseStartup()
  }
}

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
  const runId = process.env.RIVET_TEST_RUN_ID ?? 'direct'

  return setup({
    use,
    runtime: 'native',
    endpoint,
    startEngine: false,
    startServices: false,
    noWelcome: true,
    envoy: {
      poolName: `test-${runId}-${process.pid}-${crypto.randomUUID()}`,
    },
    logging: { level: 'silent' },
    shutdown: { disableSignalHandlers: true, gracePeriodMs: 1_000 },
  })
}

export async function createRivetTest<A extends Registry<RegistryActors>>(
  context: RivetTestContext,
  createRegistry: () => A
) {
  const registry = createRegistry()
  const clientCleanups: Cleanup[] = []
  const resourceCleanups: Cleanup[] = []
  const trackedActors = new Map<string, TrackedActor>()
  const testContext = {
    onTestFinished(cleanup: Cleanup) {
      clientCleanups.push(cleanup)
    },
  } as Parameters<typeof setupTest>[0]

  const finishTest = context.onTestFinished ?? onTestFinished
  let disposePromise: Promise<void> | undefined
  const dispose = () => {
    if (disposePromise) return disposePromise
    disposePromise = (async () => {
      const errors: unknown[] = []

      for (const cleanup of resourceCleanups.reverse()) {
        try {
          await withCleanupTimeout('Rivet test resource cleanup', cleanup)
        } catch (error) {
          errors.push(error)
        }
      }

      for (const trackedActor of trackedActors.values()) {
        try {
          await destroyTrackedActor(trackedActor)
        } catch (error) {
          errors.push(error)
        }
      }

      for (const cleanup of clientCleanups) {
        try {
          await withCleanupTimeout('Rivet client disposal', cleanup)
        } catch (error) {
          errors.push(error)
        }
      }

      try {
        await withCleanupTimeout('Rivet registry shutdown', () =>
          registry.shutdown()
        )
      } catch (error) {
        errors.push(error)
      }

      if (errors.length > 0) {
        throw new AggregateError(errors, 'Failed to clean up Rivet test')
      }
    })()
    return disposePromise
  }
  finishTest(dispose)

  // RivetKit 2.3.16 can time out when one Bun worker starts multiple native
  // registries simultaneously. Only startup is serialized; registries and
  // actor operations remain live and execute concurrently after readiness.
  const { client } = await serializeRegistryStartup(() =>
    setupTest(testContext, registry)
  )
  const normalizedName = context.name
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
    .slice(0, 48)
  const runId = process.env.RIVET_TEST_RUN_ID ?? 'direct'

  function actorKey(label: string) {
    const normalizedLabel = label
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase()
      .slice(0, 32)
    return `${runId}-${process.pid}-${normalizedName}-${normalizedLabel}-${crypto.randomUUID()}`
  }

  return {
    client,
    dispose,
    cleanup(callback: Cleanup) {
      resourceCleanups.push(callback)
    },
    actorKey,
    trackedActorKey(actorName: string, label = actorName) {
      const key = actorKey(label)
      trackedActors.set(`${actorName}:${key}`, { name: actorName, key })
      return key
    },
  }
}

async function engineRequest(path: string, init?: RequestInit) {
  const endpoint = process.env.RIVET_TEST_ENDPOINT
  if (!endpoint) throw new Error('RIVET_TEST_ENDPOINT is required')
  const namespace = process.env.RIVET_NAMESPACE ?? 'default'
  const url = new URL(path, `${endpoint}/`)
  url.searchParams.set('namespace', namespace)
  const response = await fetch(url, init)
  if (!response.ok) {
    throw new Error(
      `Rivet engine ${init?.method ?? 'GET'} ${url.pathname} failed: ${response.status} ${await response.text()}`
    )
  }
  return response
}

async function findTrackedActor({ name, key }: TrackedActor) {
  const response = await engineRequest(
    `/actors?name=${encodeURIComponent(name)}&key=${encodeURIComponent(key)}`
  )
  const result = (await response.json()) as {
    actors: { actor_id: string }[]
  }
  return result.actors[0]
}

async function destroyTrackedActor(actor: TrackedActor) {
  const existing = await findTrackedActor(actor)
  if (!existing) return
  await engineRequest(`/actors/${encodeURIComponent(existing.actor_id)}`, {
    method: 'DELETE',
  })

  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (!(await findTrackedActor(actor))) return
    await Bun.sleep(25)
  }
  throw new Error(
    `Timed out destroying test actor ${actor.name}:${actor.key}`
  )
}
