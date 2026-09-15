export type CliState = {
  readonly isInteractive: boolean
}

export type NormalizedCliInvocation = {
  readonly argv: string[]
  readonly state: CliState
}

export function normalizeCliInvocation(
  argv: readonly string[],
  terminal: { stdinIsTTY?: boolean; stdoutIsTTY?: boolean } = {
    stdinIsTTY: process.stdin.isTTY,
    stdoutIsTTY: process.stdout.isTTY,
  }
): NormalizedCliInvocation {
  let forcedNonInteractive = false
  const commandArgv = argv.filter(argument => {
    if (argument !== '--agent' && argument !== '--ci') return true
    forcedNonInteractive = true
    return false
  })
  return {
    argv: commandArgv,
    state: {
      isInteractive:
        !forcedNonInteractive &&
        terminal.stdinIsTTY === true &&
        terminal.stdoutIsTTY === true,
    },
  }
}
