import { spawn } from 'node:child_process'

export type AuthSelectChoice<Value extends string> = {
  name: string
  value: Value
}

export interface HarnessAuthInteraction {
  readonly isInteractive: boolean
  openUrl(url: string): Promise<void>
  select<Value extends string>(options: {
    message: string
    choices: readonly AuthSelectChoice<Value>[]
    signal: AbortSignal
  }): Promise<Value>
  log(message: string): void
  error(message: string): void
}

export function openBrowser(url: string): Promise<void> {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]]
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}
