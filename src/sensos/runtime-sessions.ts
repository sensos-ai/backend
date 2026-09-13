type ActorRecord = {
  actor_id: string
  key: string
  destroy_ts?: number | null
}

type ActorsResponse = { actors: ActorRecord[] }
type Fetcher = (input: string, init?: RequestInit) => Promise<Response>

async function listActorRecords(
  endpoint: string,
  fetcher: Fetcher
): Promise<ActorRecord[]> {
  const url = new URL('/actors', endpoint)
  url.searchParams.set('name', 'session')
  url.searchParams.set('namespace', 'default')
  const response = await fetcher(url.toString())
  if (!response.ok) {
    throw new Error(`Failed to list local sessions (${response.status})`)
  }
  return ((await response.json()) as ActorsResponse).actors
}

function deserializeSingleKey(value: string): string | undefined {
  if (!value || value === '/') return undefined
  let result = ''
  let escaping = false
  for (const character of value) {
    if (escaping) {
      if (character === '0') return undefined
      result += character
      escaping = false
    } else if (character === '\\') {
      escaping = true
    } else if (character === '/') {
      return undefined
    } else {
      result += character
    }
  }
  return escaping ? `${result}\\` : result
}

export async function waitForLocalSessionDeletion(
  endpoint: string,
  sessionId: string,
  options: {
    fetcher?: Fetcher
    timeoutMs?: number
    pollIntervalMs?: number
  } = {}
): Promise<void> {
  const fetcher = options.fetcher ?? fetch
  const deadline = Date.now() + (options.timeoutMs ?? 5_000)
  while (true) {
    const active = (await listActorRecords(endpoint, fetcher)).some(
      actor =>
        !actor.destroy_ts && deserializeSingleKey(actor.key) === sessionId
    )
    if (!active) return
    if (Date.now() >= deadline) {
      throw new Error(`Timed out deleting session ${sessionId}`)
    }
    await Bun.sleep(options.pollIntervalMs ?? 50)
  }
}

export async function deleteLocalSessionActor(
  endpoint: string,
  sessionId: string,
  fetcher: Fetcher = fetch
): Promise<void> {
  const actor = (await listActorRecords(endpoint, fetcher)).find(
    candidate =>
      !candidate.destroy_ts &&
      deserializeSingleKey(candidate.key) === sessionId
  )
  if (!actor) return
  const url = new URL(
    `/actors/${encodeURIComponent(actor.actor_id)}`,
    endpoint
  )
  url.searchParams.set('namespace', 'default')
  const response = await fetcher(url.toString(), { method: 'DELETE' })
  if (!response.ok) {
    throw new Error(`Failed to delete local session (${response.status})`)
  }
}
