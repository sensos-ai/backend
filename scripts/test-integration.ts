import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const portProbe = Bun.listen({
  hostname: '127.0.0.1',
  port: 0,
  socket: { data() {} },
})
const port = portProbe.port
portProbe.stop(true)

const storagePath = await mkdtemp(join(tmpdir(), 'sensos-suite-'))
const endpoint = `http://127.0.0.1:${port}`
const env = {
  ...process.env,
  RIVETKIT_STORAGE_PATH: storagePath,
  RIVET_RUN_ENGINE_PORT: String(port),
  RIVET_TEST_ENDPOINT: endpoint,
  SENSOS_USE_TEST_MODEL: '1',
  SENSOS_TEST_MODEL_THROW_ON_ABORT: '1',
}

const fixture = Bun.spawn(
  ['bun', 'run', 'tests/fixtures/rivet/server.ts'],
  {
    env,
    stdout: 'pipe',
    stderr: 'inherit',
  }
)

async function waitForFixture(): Promise<void> {
  const reader = fixture.stdout.getReader()
  const decoder = new TextDecoder()
  let output = ''
  const deadline = Date.now() + 35_000
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now()
    const result = await Promise.race([
      reader.read(),
      Bun.sleep(remaining).then(() => ({ done: true, value: undefined })),
    ])
    if (result.done) break
    output += decoder.decode(result.value, { stream: true })
    if (output.includes('RIVET_TEST_FIXTURE_READY')) return
  }
  throw new Error('Rivet integration fixture exited before becoming ready')
}

let exitCode = 1
try {
  await waitForFixture()
  const tests = Bun.spawn(['bun', 'test', '--no-orphans', 'integration'], {
    env,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  exitCode = await tests.exited
} finally {
  fixture.kill('SIGTERM')
  await fixture.exited
  await rm(storagePath, { recursive: true, force: true })
}

process.exit(exitCode)
