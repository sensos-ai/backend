import { createClient } from 'rivetkit/client'
import type { RivetTestRegistry } from './registry'

const endpoint = process.env.RIVET_TEST_ENDPOINT
if (!endpoint) {
  throw new Error(
    'Run Rivet integration tests with bun run test:integration'
  )
}

export function createRivetTestClient() {
  return createClient<RivetTestRegistry>(endpoint)
}
