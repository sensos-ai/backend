import {
  createHarnessProviderRegistry,
  harnessAuthKeys,
} from '@/chat/harness/providers'
import type { CliState } from '@/cli/state'
import { runCredentialsConfig } from './credentials'
import { runLogin } from './login'
import { runLogout } from './logout'
import {
  parseCredentialsConfigRequest,
  parseLoginRequest,
  parseLogoutRequest,
} from './parse'

export const AUTH_HELP_TEXT = `Usage: sensos auth <command>

Commands:
  login [provider] [--device | --apiKey [token]]
  logout [provider]
  credentials config [--storage keyring|file|auto]`

export async function runAuthCommand(
  command: 'login' | 'logout' | 'auth',
  args: readonly string[],
  state: CliState
): Promise<boolean> {
  const keys = harnessAuthKeys(createHarnessProviderRegistry())
  const nested = command === 'auth'
  const action = nested ? args[0] : command
  const actionArgs = nested ? args.slice(1) : args
  if (
    nested &&
    (action === undefined || action === '--help' || action === '-h')
  ) {
    console.log(AUTH_HELP_TEXT)
    return true
  }
  if (action === 'login') {
    if (actionArgs.includes('--help') || actionArgs.includes('-h')) {
      console.log(
        `Usage: sensos auth login [${keys.join('|')}] [--device | --apiKey [token]]`
      )
      return true
    }
    await runLogin(parseLoginRequest(actionArgs, keys), state)
    return true
  }
  if (action === 'logout') {
    if (actionArgs.includes('--help') || actionArgs.includes('-h')) {
      console.log(`Usage: sensos auth logout [${keys.join('|')}]`)
      return true
    }
    await runLogout(parseLogoutRequest(actionArgs, keys), state)
    return true
  }
  if (action === 'credentials' && actionArgs[0] === 'config') {
    if (actionArgs.includes('--help') || actionArgs.includes('-h')) {
      console.log(
        'Usage: sensos auth credentials config [--storage keyring|file|auto]'
      )
      return true
    }
    await runCredentialsConfig(
      parseCredentialsConfigRequest(actionArgs.slice(1)),
      state
    )
    return true
  }
  if (nested) {
    console.error(AUTH_HELP_TEXT)
    process.exitCode = 1
    return true
  }
  return false
}
