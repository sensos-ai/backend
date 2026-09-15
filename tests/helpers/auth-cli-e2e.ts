import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const executable = resolve('dist/sensos')

export type AuthCliE2E = {
  root: string
  config: string
  env: Record<string, string>
  profile(): Promise<Record<string, unknown>>
  run(args: readonly string[]): Promise<{
    exitCode: number
    stdout: string
    stderr: string
  }>
  startPty(args: readonly string[]): {
    screen(): string
    send(value: string): Promise<void>
    sendControlC(): Promise<void>
    waitForExit(): Promise<number>
  }
  stop(): Promise<void>
}

function stripTerminal(value: string): string {
  // biome-ignore lint/complexity/useRegexLiterals: avoids literal terminal control characters.
  const controlSequence = new RegExp('\\u001b\\[[0-?]*[ -/]*[@-~]', 'g')
  // biome-ignore lint/complexity/useRegexLiterals: avoids literal terminal control characters.
  const operatingSystemCommand = new RegExp(
    '\\u001b\\][^\\u0007]*(?:\\u0007|\\u001b\\\\)',
    'g'
  )
  return value
    .replaceAll(controlSequence, '')
    .replaceAll(operatingSystemCommand, '')
    .replaceAll('\r', '')
}

export async function createAuthCliE2E(name: string): Promise<AuthCliE2E> {
  const root = await mkdtemp(join(tmpdir(), `sensos-auth-${name}-`))
  const home = join(root, 'home')
  const config = join(root, 'config')
  const state = join(root, 'state')
  await Promise.all(
    [home, config, state].map(path => mkdir(path, { recursive: true }))
  )
  const { BUN_FEATURE_FLAG_NO_ORPHANS: _orphanPolicy, ...baseEnv } =
    process.env
  const env = {
    ...Object.fromEntries(
      Object.entries(baseEnv).filter(
        (entry): entry is [string, string] => entry[1] !== undefined
      )
    ),
    HOME: home,
    XDG_CONFIG_HOME: config,
    XDG_STATE_HOME: state,
    SENSOS_LOGGING_READY: '1',
    SENSOS_LOG_LEVEL: 'off',
    TERM: 'xterm-256color',
  }
  const children = new Set<Bun.Subprocess>()

  const api: AuthCliE2E = {
    root,
    config,
    env,
    async profile() {
      return JSON.parse(
        await readFile(join(config, 'sensos', 'auth.json'), 'utf8')
      )
    },
    async run(args) {
      const child = Bun.spawn([executable, ...args], {
        env,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      })
      children.add(child)
      try {
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ])
        return { exitCode, stdout, stderr }
      } finally {
        children.delete(child)
      }
    },
    startPty(args) {
      let output = ''
      const expectProgram = [
        'set timeout -1',
        'log_user 1',
        'set cli_args [split $env(SENSOS_AUTH_E2E_ARGS) "\\x1f"]',
        'spawn -noecho $env(SENSOS_AUTH_E2E_EXECUTABLE) {*}$cli_args',
        'interact',
        'set result [wait]',
        'exit [lindex $result 3]',
      ].join('; ')
      const child = Bun.spawn(['/usr/bin/expect', '-c', expectProgram], {
        env: {
          ...env,
          SENSOS_AUTH_E2E_EXECUTABLE: executable,
          SENSOS_AUTH_E2E_ARGS: args.join('\x1f'),
        },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      })
      children.add(child)
      const capture = async (stream: ReadableStream<Uint8Array>) => {
        for await (const chunk of stream)
          output += new TextDecoder().decode(chunk)
      }
      const captures = [capture(child.stdout), capture(child.stderr)]
      return {
        screen: () => stripTerminal(output),
        async send(value) {
          child.stdin.write(value)
          await child.stdin.flush()
        },
        async sendControlC() {
          child.stdin.write('\x03')
          await child.stdin.flush()
        },
        async waitForExit() {
          const exitCode = await child.exited
          await Promise.all(captures)
          children.delete(child)
          return exitCode
        },
      }
    },
    async stop() {
      for (const child of children) child.kill()
      await Promise.all([...children].map(child => child.exited))
      children.clear()
      await rm(root, { recursive: true, force: true })
    },
  }

  await mkdir(join(config, 'sensos'), { recursive: true })
  await writeFile(
    join(config, 'sensos', 'auth.json'),
    `${JSON.stringify({
      version: 3,
      activeProvider: 'gateway',
      storagePreference: 'file',
      credentialBackends: {},
      credentials: {},
    })}\n`
  )
  return api
}
