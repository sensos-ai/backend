import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createConnection, createServer, type Socket } from 'node:net'
import { join } from 'node:path'
import { createIdGeneratorWithPrefix } from '@/shared/utils'
import { prepareAgentOsAssets } from './agentos-assets'
import {
  onRuntimeActivityChange,
  runtimeActivityCount,
} from './activity'
import { registry } from './actors/registry'
import { prepareRivetEngine } from './assets'
import {
  DEFAULT_IDLE_TTL_MS,
  HEARTBEAT_INTERVAL_MS,
  LEASE_TIMEOUT_MS,
  MAX_IDLE_TTL_MS,
  RUNTIME_BUILD_ID,
  RUNTIME_ENDPOINT,
  RUNTIME_HOST,
  RUNTIME_PORT,
  RUNTIME_PROTOCOL_VERSION,
} from './constants'

export {
  RUNTIME_BUILD_ID,
  RUNTIME_ENDPOINT,
  RUNTIME_HOST,
  RUNTIME_PORT,
  RUNTIME_PROTOCOL_VERSION,
} from './constants'
const createLeaseId = createIdGeneratorWithPrefix('lease')
const createOwnershipToken = createIdGeneratorWithPrefix('runtime')

type RuntimeRequest =
  | { type: 'acquire'; leaseId: string }
  | { type: 'heartbeat'; leaseId: string }
  | { type: 'release'; leaseId: string }
  | { type: 'status' }
  | { type: 'stop' }

type RuntimeResponse = {
  ok: boolean
  ready?: boolean
  pid?: number
  leases?: number
  protocolVersion?: string
  buildId?: string
  error?: string
}

export function isCompatibleRuntime(
  response: Pick<RuntimeResponse, 'protocolVersion' | 'buildId'>
): boolean {
  return (
    response.protocolVersion === RUNTIME_PROTOCOL_VERSION &&
    response.buildId === RUNTIME_BUILD_ID
  )
}

type RuntimePaths = {
  directory: string
  socket: string
  state: string
  lock: string
  log: string
}

export function resolveRuntimeIdleTtl(value: string | undefined): number {
  if (value === undefined) return DEFAULT_IDLE_TTL_MS
  if (!/^\d+$/.test(value)) {
    throw new Error(
      'SENSOS_RUNTIME_IDLE_TTL_MS must be a non-negative integer'
    )
  }
  const ttl = Number(value)
  if (!Number.isSafeInteger(ttl) || ttl > MAX_IDLE_TTL_MS) {
    throw new Error(
      `SENSOS_RUNTIME_IDLE_TTL_MS must be between 0 and ${MAX_IDLE_TTL_MS}`
    )
  }
  return ttl
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

function engineEnvironment(root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    RIVET__GUARD__HOST: RUNTIME_HOST,
    RIVET__GUARD__PORT: String(RUNTIME_PORT),
    RIVET__API_PEER__HOST: RUNTIME_HOST,
    RIVET__API_PEER__PORT: String(RUNTIME_PORT + 1),
    RIVET__METRICS__HOST: RUNTIME_HOST,
    RIVET__METRICS__PORT: String(RUNTIME_PORT + 10),
    RIVET__FILE_SYSTEM__PATH: join(root, 'data', 'control-plane'),
    RIVET__TELEMETRY__ENABLED: 'false',
    RIVET__PEGBOARD__RETRY_RESET_DURATION: '100',
    RIVET__PEGBOARD__BASE_RETRY_TIMEOUT: '100',
    RIVET__PEGBOARD__RESCHEDULE_BACKOFF_MAX_EXPONENT: '1',
    RIVET__PEGBOARD__RUNNER_ELIGIBLE_THRESHOLD: '5000',
    RIVET__PEGBOARD__RUNNER_LOST_THRESHOLD: '7000',
    RIVET__PEGBOARD__ENVOY_ELIGIBLE_THRESHOLD: '5000',
    RIVET__PEGBOARD__ENVOY_LOST_THRESHOLD: '7000',
    RIVET__PEGBOARD__MIN_METADATA_POLL_INTERVAL: '1000',
    RIVET__FEATURES__GUARD_GATEWAY_V3__MODE: 'on',
    RIVET__FEATURES__GUARD_GATEWAY_V3__PERCENTAGE: '100',
    RIVET__RUNTIME__WORKER_SHUTDOWN_DURATION: '1',
    RIVET__RUNTIME__GUARD_SHUTDOWN_DURATION: '1',
    RIVET__RUNTIME__FORCE_SHUTDOWN_DURATION: '2',
  }
}

async function waitForEngine(engine: Bun.Subprocess): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (engine.exitCode !== null) {
      throw new Error('Local Rivet engine exited during startup')
    }
    try {
      const response = await fetch(`${RUNTIME_ENDPOINT}/health`)
      if (response.ok) return
    } catch {
      // Rivet has not bound its local endpoint yet.
    }
    await Bun.sleep(50)
  }
  throw new Error(
    'Local Rivet engine did not become ready within 10 seconds'
  )
}

async function stopOwnedEngine(engine: Bun.Subprocess): Promise<void> {
  if (engine.exitCode !== null) return
  engine.kill('SIGTERM')
  await Promise.race([engine.exited, Bun.sleep(5_000)])
  if (engine.exitCode === null) {
    engine.kill('SIGKILL')
    await engine.exited
  }
}

function writeResponse(socket: Socket, response: RuntimeResponse): void {
  socket.end(`${JSON.stringify(response)}\n`)
}

async function requestRuntime(
  socketPath: string,
  request: RuntimeRequest,
  timeoutMs = 12_000
): Promise<RuntimeResponse> {
  return new Promise((resolve, reject) => {
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
        resolve(JSON.parse(buffer.slice(0, newline)) as RuntimeResponse)
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
      protocolVersion?: string
      buildId?: string
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
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        try {
          await stat(paths.socket)
          await Bun.sleep(50)
        } catch {
          break
        }
      }
    }

    if (await hasLiveRecordedSupervisor(paths)) {
      throw new Error(
        'A local runtime supervisor is alive but unresponsive'
      )
    }
    await rm(paths.socket, { force: true })
    await rm(paths.state, { force: true })

    const isCompiled = process.argv[1]?.startsWith('/$bunfs/') ?? false
    const command = process.execPath
    const args = isCompiled
      ? ['__runtime-supervisor', '--root', root]
      : [process.argv[1] ?? '', '__runtime-supervisor', '--root', root]
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
        // The detached supervisor is still starting.
      }
      await Bun.sleep(50)
    }
    throw new Error(`Local runtime failed to start; see ${paths.log}`)
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
      { type: 'status' },
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

export async function runRuntimeSupervisor(root: string): Promise<never> {
  const paths = runtimePaths(root)
  await mkdir(paths.directory, { recursive: true, mode: 0o700 })
  await mkdir(join(root, 'data'), { recursive: true })
  await rm(paths.socket, { force: true })

  const ownershipToken = createOwnershipToken()
  await writeFile(
    paths.state,
    JSON.stringify({
      pid: process.pid,
      token: ownershipToken,
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      buildId: RUNTIME_BUILD_ID,
      port: RUNTIME_PORT,
      socket: paths.socket,
      startedAt: Date.now(),
    }),
    { mode: 0o600 }
  )

  const agentOsReady = prepareAgentOsAssets(root)
  const enginePath = await prepareRivetEngine(root)
  process.env.RIVET_ENGINE_BINARY = enginePath
  const engine = Bun.spawn([enginePath, 'start'], {
    env: engineEnvironment(root),
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'inherit',
  })
  const ready = Promise.all([waitForEngine(engine), agentOsReady]).then(
    async () => {
      await registry.startAndWait()
    }
  )

  const leases = new Map<string, number>()
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let shuttingDown = false
  const idleTtl = resolveRuntimeIdleTtl(
    process.env.SENSOS_RUNTIME_IDLE_TTL_MS
  )

  const shutdown = async () => {
    if (shuttingDown) return
    shuttingDown = true
    if (idleTimer) clearTimeout(idleTimer)
    server.close()
    await Promise.race([registry.shutdown(), Bun.sleep(6_000)]).catch(
      () => undefined
    )
    await stopOwnedEngine(engine)
    await rm(paths.socket, { force: true })
    await rm(paths.state, { force: true })
    process.exit(0)
  }

  const scheduleIdleShutdown = () => {
    if (leases.size > 0 || runtimeActivityCount() > 0 || shuttingDown)
      return
    if (idleTimer) return
    idleTimer = setTimeout(() => {
      idleTimer = undefined
      void shutdown()
    }, idleTtl)
    idleTimer.unref()
  }

  const server = createServer(socket => {
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('data', chunk => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      void (async () => {
        try {
          const request = JSON.parse(
            buffer.slice(0, newline)
          ) as RuntimeRequest
          if (request.type === 'status') {
            writeResponse(socket, {
              ok: true,
              ready: await Promise.race([
                ready.then(() => true),
                Bun.sleep(1).then(() => false),
              ]),
              pid: process.pid,
              leases: leases.size,
              protocolVersion: RUNTIME_PROTOCOL_VERSION,
              buildId: RUNTIME_BUILD_ID,
            })
            return
          }
          if (request.type === 'stop') {
            writeResponse(socket, { ok: true })
            await shutdown()
            return
          }
          if (request.type === 'release') {
            leases.delete(request.leaseId)
            writeResponse(socket, { ok: true })
            scheduleIdleShutdown()
            return
          }
          if (request.type === 'heartbeat') {
            if (leases.has(request.leaseId)) {
              leases.set(request.leaseId, Date.now())
            }
            writeResponse(socket, { ok: true })
            return
          }
          await ready
          if (idleTimer) {
            clearTimeout(idleTimer)
            idleTimer = undefined
          }
          leases.set(request.leaseId, Date.now())
          writeResponse(socket, { ok: true, ready: true })
        } catch (error) {
          writeResponse(socket, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      })()
    })
  })

  const removeActivityListener = onRuntimeActivityChange(count => {
    if (count > 0) {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = undefined
      return
    }
    scheduleIdleShutdown()
  })

  const leaseSweep = setInterval(() => {
    const cutoff = Date.now() - LEASE_TIMEOUT_MS
    for (const [leaseId, heartbeatAt] of leases) {
      if (heartbeatAt < cutoff) leases.delete(leaseId)
    }
    scheduleIdleShutdown()
  }, HEARTBEAT_INTERVAL_MS)
  leaseSweep.unref()

  process.once('SIGTERM', () => void shutdown())
  process.once('SIGINT', () => void shutdown())
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(paths.socket, () => resolve())
  })
  await ready.catch(async error => {
    console.error(error)
    await shutdown()
  })
  process.once('exit', removeActivityListener)
  scheduleIdleShutdown()
  return await new Promise<never>(() => undefined)
}
