export type CommandInput =
  | string
  | {
      command: string
      args?: string[]
    }

export interface SandboxRunOptions {
  cwd?: string
  env?: Record<string, string>
  signal?: AbortSignal
  timeoutMs?: number
}

export interface SandboxCommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface SandboxFileEntry {
  path: string
  type: 'file' | 'directory'
}

export interface Sandbox {
  readonly id: string
  readonly provider: 'agentos'
  readonly cwd: string

  run(
    input: CommandInput,
    options?: SandboxRunOptions
  ): Promise<SandboxCommandResult>

  files: {
    read(path: string): Promise<Uint8Array>
    write(path: string, data: Uint8Array | string): Promise<void>
    list(path: string): Promise<SandboxFileEntry[]>
    mkdir(path: string): Promise<void>
    remove(path: string): Promise<void>
    exists(path: string): Promise<boolean>
  }
}

export function decodeSandboxBytes(value: Uint8Array | string): string {
  return typeof value === 'string'
    ? value
    : new TextDecoder().decode(value)
}

export function encodeSandboxText(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}
