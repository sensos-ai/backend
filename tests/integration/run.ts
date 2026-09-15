import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getServicesPath } from '@rivet-dev/services'
import { getEnginePath } from '@rivetkit/engine-cli'

const HOST = '127.0.0.1'
const READY_TIMEOUT_MS = 15_000
const STOP_TIMEOUT_MS = 5_000
const DIAGNOSTIC_LIMIT = 64 * 1024

function reservePort() {
  return Bun.listen({
    hostname: HOST,
    port: 0,
    socket: { data() {} },
  })
}

async function capture(
  stream: ReadableStream<Uint8Array>
): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let output = ''
  for (;;) {
    const result = await reader.read()
    if (result.done) break
    output += decoder.decode(result.value, { stream: true })
    if (output.length > DIAGNOSTIC_LIMIT) {
      output = output.slice(-DIAGNOSTIC_LIMIT)
    }
  }
  return output + decoder.decode()
}

async function waitForEngine(
  engine: Bun.Subprocess,
  endpoint: string
): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (engine.exitCode !== null) {
      throw new Error(
        `Rivet engine exited during startup with code ${engine.exitCode}`
      )
    }
    try {
      const response = await fetch(`${endpoint}/health`)
      if (response.ok) return
    } catch {
      // The engine has not bound its endpoint yet.
    }
    await Bun.sleep(50)
  }
  throw new Error(
    `Rivet engine was not ready within ${READY_TIMEOUT_MS}ms`
  )
}

async function waitForServices(
  services: Bun.Subprocess,
  endpoint: string
): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (services.exitCode !== null) {
      throw new Error(
        `Rivet Services exited during startup with code ${services.exitCode}`
      )
    }
    try {
      await fetch(endpoint)
      return
    } catch {
      // Rivet Services has not bound its endpoint yet.
    }
    await Bun.sleep(50)
  }
  throw new Error(
    `Rivet Services was not ready within ${READY_TIMEOUT_MS}ms`
  )
}

async function stopProcess(process: Bun.Subprocess | undefined) {
  if (!process || process.exitCode !== null) return
  process.kill('SIGTERM')
  const stopped = await Promise.race([
    process.exited.then(() => true),
    Bun.sleep(STOP_TIMEOUT_MS).then(() => false),
  ])
  if (stopped) return
  process.kill('SIGKILL')
  await process.exited
}

const storageRoot = await mkdtemp(join(tmpdir(), 'sensos-integration-'))
const controlPlaneRoot = join(storageRoot, 'control-plane')
const testHome = join(storageRoot, 'home')
await mkdir(controlPlaneRoot, { recursive: true })
await mkdir(testHome, { recursive: true })

const probes = [reservePort(), reservePort(), reservePort(), reservePort()]
const [guardPort, peerPort, metricsPort, streamsPort] = probes.map(
  probe => probe.port
)
const endpoint = `http://${HOST}:${guardPort}`
const streamsEndpoint = `http://${HOST}:${streamsPort}`
const runId = crypto.randomUUID()
for (const probe of probes) probe.stop(true)

const env = {
  ...process.env,
  // Never let integration tests discover the developer's real Sensos
  // profile or Keychain-backed credential metadata.
  HOME: testHome,
  XDG_CONFIG_HOME: join(testHome, '.config'),
  XDG_STATE_HOME: join(testHome, '.local', 'state'),
  RIVET__GUARD__HOST: HOST,
  RIVET__GUARD__PORT: String(guardPort),
  RIVET__API_PEER__HOST: HOST,
  RIVET__API_PEER__PORT: String(peerPort),
  RIVET__METRICS__HOST: HOST,
  RIVET__METRICS__PORT: String(metricsPort),
  RIVET__FILE_SYSTEM__PATH: controlPlaneRoot,
  RIVET__TELEMETRY__ENABLED: 'false',
  RIVET__RUNTIME__WORKER_SHUTDOWN_DURATION: '1',
  RIVET__RUNTIME__GUARD_SHUTDOWN_DURATION: '1',
  RIVET__RUNTIME__FORCE_SHUTDOWN_DURATION: '2',
  RIVETKIT_STORAGE_PATH: storageRoot,
  RIVET_RUN_ENGINE: '0',
  RIVET_TEST_ENDPOINT: endpoint,
  RIVET_TEST_STREAMS_ENDPOINT: streamsEndpoint,
  RIVET_TEST_RUN_ID: runId,
  // A local engine bootstraps only its default namespace. The command's
  // unique storage root makes this namespace instance exclusive to this run.
  RIVET_NAMESPACE: 'default',
  SENSOS_USE_TEST_MODEL: '1',
}
const testTargets = process.argv.slice(2)

let engine: Bun.Subprocess | undefined
let services: Bun.Subprocess | undefined
let tests: Bun.Subprocess | undefined
let engineStdout = Promise.resolve('')
let engineStderr = Promise.resolve('')
let servicesStdout = Promise.resolve('')
let servicesStderr = Promise.resolve('')
let exitCode = 1
let interrupted = false

const interrupt = () => {
  interrupted = true
  tests?.kill('SIGTERM')
  services?.kill('SIGTERM')
  engine?.kill('SIGTERM')
}
process.once('SIGINT', interrupt)
process.once('SIGTERM', interrupt)

try {
  engine = Bun.spawn([getEnginePath(), 'start'], {
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (
    !engine.stdout ||
    typeof engine.stdout === 'number' ||
    !engine.stderr ||
    typeof engine.stderr === 'number'
  ) {
    throw new Error('Rivet engine diagnostics were not piped')
  }
  engineStdout = capture(engine.stdout)
  engineStderr = capture(engine.stderr)
  await waitForEngine(engine, endpoint)

  services = Bun.spawn([getServicesPath(), 'start'], {
    env: {
      ...env,
      RIVET_ENDPOINT: endpoint,
      HOST,
      PORT: String(streamsPort),
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (
    !services.stdout ||
    typeof services.stdout === 'number' ||
    !services.stderr ||
    typeof services.stderr === 'number'
  ) {
    throw new Error('Rivet Services diagnostics were not piped')
  }
  servicesStdout = capture(services.stdout)
  servicesStderr = capture(services.stderr)
  await waitForServices(services, streamsEndpoint)

  tests = Bun.spawn(
    [
      'bun',
      'test',
      '--no-orphans',
      '--parallel=4',
      ...(testTargets.length > 0 ? testTargets : ['tests/integration']),
    ],
    {
      env,
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    }
  )
  exitCode = await tests.exited
} catch (error) {
  console.error(error)
} finally {
  process.off('SIGINT', interrupt)
  process.off('SIGTERM', interrupt)
  await stopProcess(tests)
  await stopProcess(services)
  await stopProcess(engine)

  const [stdout, stderr, streamStdout, streamStderr] = await Promise.all([
    engineStdout,
    engineStderr,
    servicesStdout,
    servicesStderr,
  ])
  if (exitCode !== 0) {
    if (stdout.trim()) console.error('Rivet engine stdout:\n', stdout)
    if (stderr.trim()) console.error('Rivet engine stderr:\n', stderr)
    if (streamStdout.trim())
      console.error('Rivet Services stdout:\n', streamStdout)
    if (streamStderr.trim())
      console.error('Rivet Services stderr:\n', streamStderr)
  }

  await rm(storageRoot, { recursive: true, force: true })
}

process.exit(interrupted ? 130 : exitCode)
