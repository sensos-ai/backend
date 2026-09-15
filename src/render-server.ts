import { productStateDir } from '@/config/paths'
import {
  RUNTIME_ENDPOINT,
  RUNTIME_STREAMS_ENDPOINT,
} from '@/runtime/constants'
import { runRuntimeSupervisor } from '@/runtime'

const startupTimeoutMs = 30_000

async function waitForEndpoint(
  url: string,
  label: string,
  requireOk = true
): Promise<void> {
  const deadline = Date.now() + startupTimeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (!requireOk || response.ok) return
    } catch {
      // The embedded service is still starting.
    }
    await Bun.sleep(100)
  }
  throw new Error(
    `${label} did not become ready within ${startupTimeoutMs}ms`
  )
}

// A hosted engine has no local CLI lease to keep its supervisor alive.
process.env.SENSOS_RUNTIME_IDLE_TTL_MS ??= String(24 * 60 * 60_000)

void runRuntimeSupervisor(productStateDir())
await Promise.all([
  waitForEndpoint(`${RUNTIME_ENDPOINT}/health`, 'Rivet Engine'),
  waitForEndpoint(RUNTIME_STREAMS_ENDPOINT, 'Rivet Services', false),
])
await import('./server')
