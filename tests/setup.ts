import { afterAll } from 'bun:test'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

const configuredRuntimeRoot = process.env.RIVETKIT_STORAGE_PATH
if (!configuredRuntimeRoot?.startsWith('/tmp/sensos-suite-')) {
  throw new Error('RIVETKIT_STORAGE_PATH must use isolated test storage')
}
const runtimeRoot = configuredRuntimeRoot

process.env.RIVET_RUN_ENGINE_PORT = '26420'

async function stopOwnedTestEngine(): Promise<void> {
  let pid: number
  try {
    const runtime = JSON.parse(
      await readFile(
        join(runtimeRoot, '.rivetkit', 'var', 'engine', 'runtime.json'),
        'utf8'
      )
    ) as { pid?: number }
    if (!runtime.pid) return
    pid = runtime.pid
  } catch {
    return
  }

  try {
    process.kill(pid, 0)
  } catch {
    return
  }

  const [processInfo, openFiles] = await Promise.all([
    Bun.$`ps -p ${pid} -o command=`
      .quiet()
      .text()
      .catch(() => ''),
    Bun.$`lsof -p ${pid}`
      .quiet()
      .text()
      .catch(() => ''),
  ])
  if (
    !processInfo.includes('rivet-engine start') ||
    !openFiles.includes(runtimeRoot)
  ) {
    throw new Error(`Refusing to stop unowned test process ${pid}`)
  }

  process.kill(pid, 'SIGTERM')
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
      await Bun.sleep(50)
    } catch {
      return
    }
  }
  process.kill(pid, 'SIGKILL')
}

afterAll(async () => {
  await stopOwnedTestEngine()
  await rm(runtimeRoot, { recursive: true, force: true })
})
