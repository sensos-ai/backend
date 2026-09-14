import { createServer } from 'node:net'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
    const ports = [candidate, candidate + 1, candidate + 10]
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
  waitForScreen(text: string, timeoutMs?: number): Promise<string>
  waitForExit(timeoutMs?: number): Promise<number>
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
  scenario: ScriptedScenario
): Promise<CliE2E> {
  const id = `${name.replaceAll(/[^a-z0-9]+/gi, '-')}-${crypto.randomUUID()}`
  const root = await mkdtemp(join(tmpdir(), 'sensos-e2e-'))
  const home = join(root, 'home')
  const config = join(root, 'config')
  const state = join(root, 'state')
  const workspace = join(root, 'workspace')
  const logs = join(root, 'logs')
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
  catalog.close()

  const gateway = startScriptedGateway(scenario)
  const port = await reserveRuntimePort()
  const endpoint = `http://127.0.0.1:${port}`
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: config,
    XDG_STATE_HOME: state,
    SENSOS_RUNTIME_PORT: String(port),
    SENSOS_RUNTIME_IDLE_TTL_MS: '0',
    SENSOS_GATEWAY_BASE_URL: gateway.url,
    AI_GATEWAY_API_KEY: 'e2e-scripted-gateway',
    SENSOS_AI_EVENT_LOG_PATH: join(logs, 'ai-events.log'),
    SENSOS_LOG_LEVEL: 'warn',
    SENSOS_E2E_EXECUTABLE: executable,
    SENSOS_E2E_SESSION_ID: sessionId,
    SENSOS_E2E_WORKSPACE: workspace,
    TERM: 'xterm-256color',
  }
  const expectProgram = [
    'set timeout -1',
    'log_user 1',
    'spawn -noecho $env(SENSOS_E2E_EXECUTABLE) session $env(SENSOS_E2E_SESSION_ID) --cwd $env(SENSOS_E2E_WORKSPACE)',
    'interact',
    'set result [wait]',
    'exit [lindex $result 3]',
  ].join('; ')
  const child = Bun.spawn(['/usr/bin/expect', '-c', expectProgram], {
    cwd: workspace,
    env,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  let output = ''
  const capture = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream)
      output += new TextDecoder().decode(chunk)
  }
  const stdout = capture(child.stdout)
  const stderr = capture(child.stderr)
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
      const runtimeStop = Bun.spawn([executable, 'runtime', 'stop'], {
        env,
        stdout: 'ignore',
        stderr: 'ignore',
      })
      await Promise.race([runtimeStop.exited, Bun.sleep(8_000)])
      await gateway.stop()
      await Promise.allSettled([stdout, stderr])
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
    await api.waitForScreen('Agent ready', 20_000)
    return api
  } catch (error) {
    await api.stop()
    throw error
  }
}
