import type { AgentOs } from '@rivet-dev/agentos'
import { posix } from 'node:path'
import { recordTiming } from '@/shared/timing'
import {
  decodeSandboxBytes,
  type CommandInput,
  type Sandbox,
  type SandboxCommandResult,
  type SandboxRunOptions,
} from './harness/sandbox'
import { DEFAULT_WORKSPACE_PATH } from './harness/constants'

export interface CreateAgentOsSandboxOptions {
  id: string
  vm: AgentOs
  cwd?: string
}

function normalizeOutput(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }

  if (value instanceof Uint8Array) {
    return decodeSandboxBytes(value)
  }

  if (value == null) {
    return ''
  }

  return String(value)
}

function normalizeCommandResult(result: {
  exitCode?: number
  code?: number
  stdout?: unknown
  stderr?: unknown
}): SandboxCommandResult {
  return {
    exitCode: result.exitCode ?? result.code ?? 0,
    stdout: normalizeOutput(result.stdout),
    stderr: normalizeOutput(result.stderr),
  }
}

export function createAgentOsSandbox(
  options: CreateAgentOsSandboxOptions
): Sandbox {
  const { id, vm } = options
  const cwd = options.cwd ?? DEFAULT_WORKSPACE_PATH

  return {
    id,
    provider: 'agentos',
    cwd,

    async run(
      input: CommandInput,
      runOptions: SandboxRunOptions = {}
    ): Promise<SandboxCommandResult> {
      const startedAt = Date.now()
      const mode = typeof input === 'string' ? 'shell' : 'file'
      recordTiming('agentos.process.start', { sessionId: id, mode })
      const commonOptions = {
        cwd: runOptions.cwd ?? cwd,
        env: runOptions.env,
        signal: runOptions.signal,
        timeoutMs: runOptions.timeoutMs,
      }

      try {
        const result =
          typeof input === 'string'
            ? await vm.process.exec(input, commonOptions)
            : await vm.process.execFile(
                input.command,
                input.args ?? [],
                commonOptions
              )
        const normalized = normalizeCommandResult(result)
        recordTiming('agentos.process.ready', {
          sessionId: id,
          mode,
          exitCode: normalized.exitCode,
          elapsedMs: Date.now() - startedAt,
        })
        return normalized
      } catch (error) {
        recordTiming('agentos.process.failed', {
          sessionId: id,
          mode,
          elapsedMs: Date.now() - startedAt,
        })
        throw error
      }
    },

    files: {
      async read(path) {
        return vm.filesystem.readFile(path)
      },

      async write(path, data) {
        await vm.filesystem.writeFile(path, data)
      },

      async list(path) {
        const entries = await vm.filesystem.readdirEntries(path)

        return entries.map(entry => ({
          path: posix.join(path, entry.name),
          type: entry.isDirectory ? 'directory' : 'file',
        }))
      },

      async mkdir(path) {
        await vm.filesystem.mkdir(path, { recursive: true })
      },

      async remove(path) {
        await vm.filesystem.remove(path, { recursive: true })
      },

      async exists(path) {
        try {
          await vm.filesystem.stat(path)
          return true
        } catch {
          return false
        }
      },
    },
  }
}
