import { createServer } from 'node:net'
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createClient } from 'rivetkit/client'
import type { registry } from '@/runtime/actors/registry'
import { openSessionCatalog } from '@/storage/session-catalog'
import type { ScriptedScenario } from '../fixtures/llm/scenario'
import {
  startScriptedGateway,
  type ScriptedGateway,
} from './scripted-gateway'
import { waitForValue } from './wait'

const executable = resolve('dist/sensos')

async function reserveRuntimePort(): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = 10_000 + Math.floor(Math.random() * 40_000)
    const ports = [candidate, candidate + 1, candidate + 2, candidate + 10]
    const servers = ports.map(() => createServer())
    try {
      await Promise.all(
        servers.map(
          (server, index) =>
            new Promise<void>((resolveListen, reject) => {
              server.once('error', reject)
              server.listen(ports[index], '127.0.0.1', resolveListen)
            })
        )
      )
      await Promise.all(
        servers.map(
          server => new Promise<void>(done => server.close(() => done()))
        )
      )
      return candidate
    } catch {
      await Promise.all(
        servers.map(
          server =>
            new Promise<void>(done =>
              server.listening ? server.close(() => done()) : done()
            )
        )
      )
    }
  }
  throw new Error('Could not reserve an isolated Rivet port set')
}

async function bindRuntimePorts(port: number) {
  const ports = [port, port + 1, port + 2, port + 10]
  const servers = ports.map(() => createServer())
  try {
    await Promise.all(
      servers.map(
        (server, index) =>
          new Promise<void>((resolveListen, reject) => {
            server.once('error', reject)
            server.listen(ports[index], '127.0.0.1', resolveListen)
          })
      )
    )
    return servers
  } catch (error) {
    await closeServers(servers)
    throw error
  }
}

async function closeServers(servers: ReturnType<typeof createServer>[]) {
  await Promise.all(
    servers.map(
      server =>
        new Promise<void>(done =>
          server.listening ? server.close(() => done()) : done()
        )
    )
  )
}

function stripTerminal(value: string): string {
  // biome-ignore lint/complexity/useRegexLiterals: String form avoids literal control characters.
  const controlSequence = new RegExp('\\u001b\\[[0-?]*[ -/]*[@-~]', 'g')
  // biome-ignore lint/complexity/useRegexLiterals: String form avoids literal control characters.
  const operatingSystemCommand = new RegExp(
    '\\u001b\\][^\\u0007]*(?:\\u0007|\\u001b\\\\)',
    'g'
  )
  return value
    .replaceAll(controlSequence, '')
    .replaceAll(operatingSystemCommand, '')
    .replaceAll('\r', '')
}

export type CliE2E = {
  sessionId: string
  gateway: ScriptedGateway
  endpoint: string
  screen(): string
  sendLine(value: string): Promise<void>
  sendControlC(): Promise<void>
  sendDown(): Promise<void>
  disconnect(): Promise<number>
  resume(): Promise<void>
  reserveSession(title: string): Promise<string>
  waitForScreen(text: string, timeoutMs?: number): Promise<string>
  waitForExit(timeoutMs?: number): Promise<number>
  waitForNoOrphans(timeoutMs?: number): Promise<void>
  connect(
    clientId?: string
  ): ReturnType<
    ReturnType<
      typeof createClient<typeof registry>
    >['session']['getOrCreate']
  >
  stop(): Promise<void>
}

export async function startCliE2E(
  name: string,
  scenario: ScriptedScenario,
  options: { failRuntimeStartup?: boolean } = {}
): Promise<CliE2E> {
  const id = `${name.replaceAll(/[^a-z0-9]+/gi, '-')}-${crypto.randomUUID()}`
  const root = await mkdtemp(join(tmpdir(), 'sensos-e2e-'))
  const home = join(root, 'home')
  const config = join(root, 'config')
  const state = join(root, 'state')
  const workspace = join(root, 'workspace')
  const logs = join(root, 'logs')
  const cliPidPath = join(root, 'cli.pid')
  await Promise.all(
    [home, config, state, workspace, logs].map(path =>
      mkdir(path, { recursive: true })
    )
  )
  const sessionId = `session_${id}`
  const catalogPath = join(state, 'sensos', 'catalog.sqlite')
  const catalog = openSessionCatalog(catalogPath)
  await catalog.reserve({
    sessionId,
    cwd: workspace,
    title: `E2E ${name}`,
  })

  const gateway = startScriptedGateway(scenario)
  const port = await reserveRuntimePort()
  const blockedRuntimePorts = options.failRuntimeStartup
    ? await bindRuntimePorts(port)
    : []
  const endpoint = `http://127.0.0.1:${port}`
  const {
    BUN_FEATURE_FLAG_NO_ORPHANS: _testRunnerOrphanPolicy,
    ...runtimeEnvironment
  } = process.env
  const env = {
    ...runtimeEnvironment,
    HOME: home,
    XDG_CONFIG_HOME: config,
    XDG_STATE_HOME: state,
    SENSOS_RUNTIME_PORT: String(port),
    // Keep lifecycle tests fast. Active and queued runs pin the supervisor,
    // so this short idle window does not weaken detachment coverage.
    SENSOS_RUNTIME_IDLE_TTL_MS: '100',
    SENSOS_GATEWAY_BASE_URL: gateway.url,
    AI_GATEWAY_API_KEY: 'e2e-scripted-gateway',
    SENSOS_AI_EVENT_LOG_PATH: join(logs, 'ai-events.log'),
    SENSOS_LOG_LEVEL: 'warn',
    SENSOS_E2E_EXECUTABLE: executable,
    SENSOS_E2E_SESSION_ID: sessionId,
    SENSOS_E2E_WORKSPACE: workspace,
    SENSOS_E2E_CLI_PID_PATH: cliPidPath,
    // Run the compiled command directly so hard-disconnect tests can kill
    // exactly the client process without involving the logging bootstrap.
    SENSOS_LOGGING_READY: '1',
    TERM: 'xterm-256color',
  }
  let output = ''
  let child: Bun.Subprocess<'pipe', 'pipe', 'pipe'>
  const captures: Promise<void>[] = []
  const capture = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream)
      output += new TextDecoder().decode(chunk)
  }
  const spawnCli = (command: 'session' | 'resume') => {
    const expectProgram = [
      'set timeout -1',
      'log_user 1',
      `spawn -noecho $env(SENSOS_E2E_EXECUTABLE) ${command} $env(SENSOS_E2E_SESSION_ID) --cwd $env(SENSOS_E2E_WORKSPACE)`,
      'set pid_file [open $env(SENSOS_E2E_CLI_PID_PATH) w]',
      'puts $pid_file [exp_pid]',
      'close $pid_file',
      'interact',
      'set result [wait]',
      'exit [lindex $result 3]',
    ].join('; ')
    child = Bun.spawn(['/usr/bin/expect', '-c', expectProgram], {
      cwd: workspace,
      env,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    captures.push(capture(child.stdout), capture(child.stderr))
  }
  spawnCli('session')
  let stopped = false

  const api: CliE2E = {
    sessionId,
    gateway,
    endpoint,
    screen: () => stripTerminal(output),
    async sendLine(value) {
      for (const character of value) {
        child.stdin.write(character)
        await child.stdin.flush()
        await Bun.sleep(2)
      }
      child.stdin.write('\r')
      await child.stdin.flush()
    },
    async sendControlC() {
      child.stdin.write('\x03')
      await child.stdin.flush()
    },
    async sendDown() {
      child.stdin.write('\x1b[B')
      await child.stdin.flush()
    },
    async disconnect() {
      const cliPid = Number((await readFile(cliPidPath, 'utf8')).trim())
      if (!Number.isSafeInteger(cliPid) || cliPid <= 0) {
        throw new Error(`Invalid CLI pid ${JSON.stringify(cliPid)}`)
      }
      const runtimeState = JSON.parse(
        await readFile(
          join(state, 'sensos', 'runtime', 'supervisor', 'state.json'),
          'utf8'
        )
      ) as { pid?: number }
      if (!runtimeState.pid || runtimeState.pid === cliPid) {
        throw new Error(
          `Invalid process ownership: CLI ${cliPid}, supervisor ${runtimeState.pid}`
        )
      }
      process.kill(cliPid, 'SIGKILL')
      const exitCode = await api.waitForExit()
      process.kill(runtimeState.pid, 0)
      return exitCode
    },
    async resume() {
      if (child.exitCode === null) {
        throw new Error('Cannot resume while the original CLI is running')
      }
      output += '\n--- resumed CLI ---\n'
      spawnCli('resume')
    },
    async reserveSession(title) {
      const nextSessionId = `session_${name.replaceAll(/[^a-z0-9]+/gi, '-')}-${crypto.randomUUID()}`
      await catalog.reserve({
        sessionId: nextSessionId,
        cwd: workspace,
        title,
      })
      return nextSessionId
    },
    async waitForScreen(text, timeoutMs = 15_000) {
      return waitForValue(api.screen, value => value.includes(text), {
        description: `terminal output containing ${JSON.stringify(text)}`,
        timeoutMs,
      })
    },
    async waitForExit(timeoutMs = 15_000) {
      return Promise.race([
        child.exited,
        Bun.sleep(timeoutMs).then(() => {
          throw new Error(`CLI did not exit; screen:\n${api.screen()}`)
        }),
      ])
    },
    async waitForNoOrphans(timeoutMs = 15_000) {
      const directory = join(state, 'sensos', 'runtime', 'supervisor')
      const statePath = join(directory, 'state.json')
      const socketPath = join(directory, 'control.sock')
      let supervisorPid: number | undefined
      try {
        supervisorPid = (
          JSON.parse(await readFile(statePath, 'utf8')) as { pid?: number }
        ).pid
      } catch {
        // A fast shutdown may remove state before observation begins.
      }
      type OrphanObservation = {
        stateExists: boolean
        socketExists: boolean
        supervisorAlive: boolean
        portsAvailable: boolean
      }
      let lastObservation: OrphanObservation | undefined
      const observe = async (): Promise<OrphanObservation> => {
        const exists = async (path: string) => {
          try {
            await stat(path)
            return true
          } catch {
            return false
          }
        }
        let supervisorAlive = false
        if (supervisorPid) {
          try {
            process.kill(supervisorPid, 0)
            supervisorAlive = true
          } catch {
            // The recorded supervisor exited.
          }
        }
        let portsAvailable = false
        try {
          const probes = await bindRuntimePorts(port)
          await closeServers(probes)
          portsAvailable = true
        } catch {
          // The engine is still releasing a listener.
        }
        return {
          stateExists: await exists(statePath),
          socketExists: await exists(socketPath),
          supervisorAlive,
          portsAvailable,
        }
      }
      try {
        await waitForValue(
          async () => {
            lastObservation = await observe()
            return lastObservation
          },
          value => !value.supervisorAlive && value.portsAvailable,
          {
            description: 'CLI and runtime resources to be released',
            timeoutMs,
          }
        )
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}: ${JSON.stringify(lastObservation)}`
        )
      }
    },
    connect(clientId = `e2e-observer-${crypto.randomUUID()}`) {
      return createClient<typeof registry>(endpoint).session.getOrCreate(
        [sessionId],
        { params: { clientId } }
      )
    },
    async stop() {
      if (stopped) return
      stopped = true
      child.stdin.end()
      if (child.exitCode === null) child.kill('SIGTERM')
      await Promise.race([child.exited, Bun.sleep(3_000)])
      if (child.exitCode === null) child.kill('SIGKILL')
      await closeServers(blockedRuntimePorts)
      const runtimeStop = Bun.spawn([executable, 'runtime', 'stop'], {
        env,
        stdout: 'ignore',
        stderr: 'ignore',
      })
      await Promise.race([runtimeStop.exited, Bun.sleep(8_000)])
      await gateway.stop()
      await Promise.allSettled(captures)
      catalog.close()
      const artifacts = resolve('tests/e2e/artifacts')
      await mkdir(artifacts, { recursive: true })
      await Promise.all([
        writeFile(join(artifacts, `${id}.terminal.log`), output),
        writeFile(
          join(artifacts, `${id}.gateway.json`),
          `${JSON.stringify({ requests: gateway.requests, aborts: gateway.aborts }, null, 2)}\n`
        ),
      ])
      const runtimeLog = Bun.file(
        join(state, 'sensos', 'runtime', 'supervisor', 'runtime.log')
      )
      if (await runtimeLog.exists()) {
        await writeFile(
          join(artifacts, `${id}.runtime.log`),
          new Uint8Array(await runtimeLog.arrayBuffer())
        )
      }
      await rm(root, { recursive: true, force: true })
    },
  }
  try {
    await api.waitForScreen(
      options.failRuntimeStartup ? 'Waking…' : '● Ready',
      20_000
    )
    return api
  } catch (error) {
    await api.stop()
    throw error
  }
}
