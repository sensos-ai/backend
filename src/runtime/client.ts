import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { createIdGeneratorWithPrefix } from '@/shared/utils'
import {
  HEARTBEAT_INTERVAL_MS,
  RUNTIME_BUILD_ID,
  RUNTIME_ENDPOINT,
  RUNTIME_PROTOCOL_VERSION,
} from './constants'

const createLeaseId = createIdGeneratorWithPrefix('lease')

type RuntimeRequest =
  | { type: 'acquire'; leaseId: string }
  | { type: 'heartbeat'; leaseId: string }
  | { type: 'release'; leaseId: string }
  | { type: 'status' }
  | { type: 'stop' }

export type RuntimeResponse = {
  ok: boolean
  ready?: boolean
  pid?: number
  leases?: number
  protocolVersion?: string
  buildId?: string
  error?: string
}

type RuntimePaths = {
  directory: string
  socket: string
  state: string
  lock: string
  log: string
}

function runtimePaths(root: string): RuntimePaths {
  const directory = join(root, 'runtime', 'supervisor')
  return {
    directory,
    socket: join(directory, 'control.sock'),
    state: join(directory, 'state.json'),
    lock: join(directory, 'startup.lock'),
    log: join(directory, 'runtime.log'),
  }
}

function isCompatibleRuntime(
  response: Pick<RuntimeResponse, 'protocolVersion' | 'buildId'>
): boolean {
  return (
    response.protocolVersion === RUNTIME_PROTOCOL_VERSION &&
    response.buildId === RUNTIME_BUILD_ID
  )
}

async function requestRuntime(
  socketPath: string,
  request: RuntimeRequest,
  timeoutMs = 12_000
): Promise<RuntimeResponse> {
  return new Promise((resolveRequest, reject) => {
    const socket = createConnection(socketPath)
    let buffer = ''
    const timeout = setTimeout(() => {
      socket.destroy()
      reject(new Error('Local runtime supervisor timed out'))
    }, timeoutMs)
    socket.setEncoding('utf8')
    socket.on('connect', () =>
      socket.write(`${JSON.stringify(request)}\n`)
    )
    socket.on('data', chunk => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      clearTimeout(timeout)
      socket.end()
      try {
        resolveRequest(
          JSON.parse(buffer.slice(0, newline)) as RuntimeResponse
        )
      } catch (error) {
        reject(error)
      }
    })
    socket.on('error', error => {
      clearTimeout(timeout)
      reject(error)
    })
  })
}

async function hasLiveRecordedSupervisor(
  paths: RuntimePaths
): Promise<boolean> {
  try {
    const state = JSON.parse(await readFile(paths.state, 'utf8')) as {
      pid?: number
      token?: string
    }
    if (!state.pid || !state.token) return false
    process.kill(state.pid, 0)
    return true
  } catch {
    return false
  }
}

async function acquireStartupLock(
  paths: RuntimePaths
): Promise<() => Promise<void>> {
  await mkdir(paths.directory, { recursive: true, mode: 0o700 })
  const deadline = Date.now() + 12_000
  while (true) {
    try {
      await mkdir(paths.lock)
      return () => rm(paths.lock, { recursive: true, force: true })
    } catch {
      if (Date.now() >= deadline) {
        throw new Error('Timed out waiting for runtime startup lock')
      }
      try {
        const lock = await stat(paths.lock)
        if (Date.now() - lock.mtimeMs > 15_000) {
          await rm(paths.lock, { recursive: true, force: true })
          continue
        }
      } catch {
        // Another process released it between checks.
      }
      await Bun.sleep(50)
    }
  }
}

function localEngineCommand(root: string): {
  command: string
  args: string[]
} {
  const isCompiled = process.argv[1]?.startsWith('/$bunfs/') ?? false
  if (isCompiled) {
    const configured = process.env.SENSOS_LOCAL_ENGINE_PATH?.trim()
    return {
      command:
        configured || join(dirname(process.execPath), 'sensos-engine'),
      args: ['__runtime-supervisor', '--root', root],
    }
  }
  return {
    command: process.execPath,
    args: [
      resolve(import.meta.dir, 'engine-bootstrap.ts'),
      '--root',
      root,
    ],
  }
}

async function startSupervisor(root: string): Promise<void> {
  const paths = runtimePaths(root)
  const releaseLock = await acquireStartupLock(paths)
  try {
    let existing: RuntimeResponse | undefined
    try {
      existing = await requestRuntime(
        paths.socket,
        { type: 'status' },
        500
      )
    } catch {
      // No supervisor is listening on the recorded socket.
    }
    if (existing?.ok) {
      if (isCompatibleRuntime(existing)) return
      if ((existing.leases ?? 0) > 0) {
        throw new Error(
          'The local runtime protocol or build changed while active chats still hold leases. Close those chats or run `sensos runtime stop`, then try again.'
        )
      }
      await requestRuntime(paths.socket, { type: 'stop' }, 6_000)
    }
    if (await hasLiveRecordedSupervisor(paths)) {
      throw new Error(
        'A local runtime supervisor is alive but unresponsive'
      )
    }
    await rm(paths.socket, { force: true })
    await rm(paths.state, { force: true })

    const { command, args } = localEngineCommand(root)
    const logFd = openSync(paths.log, 'a', 0o600)
    try {
      const child = spawn(command, args, {
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: process.env,
      })
      child.unref()
    } finally {
      closeSync(logFd)
    }

    const deadline = Date.now() + 12_000
    while (Date.now() < deadline) {
      try {
        const status = await requestRuntime(paths.socket, {
          type: 'status',
        })
        if (status.ok && isCompatibleRuntime(status)) return
      } catch {
        // The detached engine process is still starting.
      }
      await Bun.sleep(50)
    }
    throw new Error(
      `Local engine failed to start; install sensos-engine beside sensos or set SENSOS_LOCAL_ENGINE_PATH. See ${paths.log}`
    )
  } finally {
    await releaseLock()
  }
}

export type RuntimeLease = {
  ready: Promise<{ endpoint: string }>
  release(): Promise<void>
}

export function acquireRuntime(root: string): RuntimeLease {
  const paths = runtimePaths(root)
  const leaseId = createLeaseId()
  let released = false
  let heartbeat: ReturnType<typeof setInterval> | undefined
  const ready = (async () => {
    await startSupervisor(root)
    const response = await requestRuntime(paths.socket, {
      type: 'acquire',
      leaseId,
    })
    if (!response.ok)
      throw new Error(response.error ?? 'Runtime unavailable')
    heartbeat = setInterval(() => {
      requestRuntime(
        paths.socket,
        { type: 'heartbeat', leaseId },
        2_000
      ).catch(() => undefined)
    }, HEARTBEAT_INTERVAL_MS)
    heartbeat.unref()
    return { endpoint: RUNTIME_ENDPOINT }
  })()

  return {
    ready,
    async release() {
      if (released) return
      released = true
      if (heartbeat) clearInterval(heartbeat)
      try {
        await ready
        await requestRuntime(
          paths.socket,
          { type: 'release', leaseId },
          2_000
        )
      } catch {
        // Failed startup and crashed supervisors have no lease to release.
      }
    },
  }
}

export async function runtimeStatus(
  root: string
): Promise<RuntimeResponse> {
  try {
    return await requestRuntime(
      runtimePaths(root).socket,
      {
        type: 'status',
      },
      500
    )
  } catch {
    return {
      ok: true,
      ready: false,
      leases: 0,
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      buildId: RUNTIME_BUILD_ID,
    }
  }
}

export async function stopRuntime(root: string): Promise<boolean> {
  const paths = runtimePaths(root)
  try {
    const response = await requestRuntime(
      paths.socket,
      { type: 'stop' },
      6_000
    )
    if (!response.ok) return false
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      try {
        await stat(paths.socket)
        await Bun.sleep(50)
      } catch {
        return true
      }
    }
    throw new Error('Runtime supervisor did not finish shutting down')
  } catch {
    return false
  }
}
