import { expect, test } from 'bun:test'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

const RESULT_PREFIX = 'RIVET_ISOLATION_RESULT '

type IsolationResult = { key: string; value: string }

function startWorker(
  value: string,
  readyPath: string,
  peerReadyPath: string
) {
  return Bun.spawn(
    [
      'bun',
      'run',
      'tests/helpers/rivet-isolation-worker.ts',
      value,
      readyPath,
      peerReadyPath,
    ],
    {
      env: process.env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'inherit',
    }
  )
}

async function readResult(
  worker: ReturnType<typeof startWorker>
): Promise<IsolationResult> {
  if (!worker.stdout || typeof worker.stdout === 'number') {
    throw new Error('Isolation worker stdout was not piped')
  }
  const reader = worker.stdout.getReader()
  const decoder = new TextDecoder()
  let output = ''
  const deadline = Date.now() + 15_000

  while (Date.now() < deadline) {
    const result = await Promise.race([
      reader.read(),
      Bun.sleep(deadline - Date.now()).then(() => undefined),
    ])
    if (!result || result.done) break
    output += decoder.decode(result.value, { stream: true })
    const resultLine = output
      .split('\n')
      .find(line => line.startsWith(RESULT_PREFIX))
    if (resultLine) {
      return JSON.parse(resultLine.slice(RESULT_PREFIX.length))
    }
  }

  throw new Error(`Isolation worker did not become ready:\n${output}`)
}

async function stopWorker(worker: ReturnType<typeof startWorker>) {
  const exitCode = await worker.exited
  if (exitCode !== 0) {
    throw new Error(`Isolation worker exited with code ${exitCode}`)
  }
}

test('parallel registry processes keep actor identities and state isolated', async () => {
  const storageRoot = process.env.RIVETKIT_STORAGE_PATH
  if (!storageRoot) throw new Error('RIVETKIT_STORAGE_PATH is required')
  for (let iteration = 0; iteration < 3; iteration++) {
    const barrierRoot = join(storageRoot, `isolation-${iteration}`)
    const leftReady = join(barrierRoot, 'left')
    const rightReady = join(barrierRoot, 'right')
    await mkdir(barrierRoot, { recursive: true })
    const left = startWorker(`left-${iteration}`, leftReady, rightReady)
    const right = startWorker(`right-${iteration}`, rightReady, leftReady)
    try {
      const [leftResult, rightResult] = await Promise.all([
        readResult(left),
        readResult(right),
      ])
      expect(leftResult.key).not.toBe(rightResult.key)
      expect([leftResult.value, rightResult.value]).toEqual([
        `left-${iteration}`,
        `right-${iteration}`,
      ])
    } finally {
      await Promise.all([stopWorker(left), stopWorker(right)])
      await rm(barrierRoot, { recursive: true, force: true })
    }
  }
}, 45_000)
