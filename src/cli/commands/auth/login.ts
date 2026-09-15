import { select } from '@inquirer/prompts'
import {
  createHarnessAuthRegistry,
  createHarnessProviderRegistry,
  harnessAuthKeys,
  type AuthStrategy,
  type AuthStrategyName,
} from '@/chat/harness/providers'
import {
  persistProviderCredential,
  readProviderProfile,
} from '@/auth/profile'
import {
  openBrowser,
  type HarnessAuthInteraction,
} from '@/chat/harness/providers/auth-interaction'
import type { CliState } from '@/cli/state'
import type { LoginRequest } from './parse'

const labels: Record<AuthStrategyName, string> = {
  'oauth-pkce': 'Sign in',
  'oauth-device': 'Sign in with device',
  apiKey: 'API key',
}

export async function runLogin(
  request: LoginRequest,
  state: CliState
): Promise<void> {
  const initial = createHarnessProviderRegistry()
  const keys = harnessAuthKeys(initial)
  let authKey = request.provider
  if (!authKey) {
    if (!state.isInteractive)
      throw new Error(
        `Usage: sensos auth login <${keys.join('|')}> [--device | --apiKey [token]]`
      )
    authKey = await select({
      message: 'Choose a provider',
      choices: keys.map(key => ({
        name: createHarnessAuthRegistry(initial)[key].displayName,
        value: key,
      })),
    })
  }

  const profile = await readProviderProfile()
  const interaction: HarnessAuthInteraction = {
    isInteractive: state.isInteractive,
    openUrl: openBrowser,
    select: options =>
      select(
        { message: options.message, choices: [...options.choices] },
        { signal: options.signal }
      ),
    log: console.log,
    error: console.error,
  }
  const providers = createHarnessProviderRegistry(profile.credentials, {
    gateway: { interaction },
    codex: { interaction },
  })
  const provider = createHarnessAuthRegistry(providers)[authKey]
  const supportedStrategies =
    provider.supportedAuthStrategies as readonly AuthStrategyName[]
  let strategy: AuthStrategy | undefined = request.strategy
  if (!strategy && state.isInteractive) {
    if (
      supportedStrategies.length === 1 &&
      supportedStrategies[0] === 'apiKey'
    ) {
      const environment = provider.apiKeyEnvironmentVariable
      throw new Error(
        `Run \`sensos login ${authKey} --apiKey <token>\`${environment ? ` or set ${environment}` : ''}.`
      )
    }
    const type = await select({
      message: `Sign in to ${provider.displayName}`,
      choices: supportedStrategies.map(type => ({
        name: `${labels[type]}${type === provider.defaultAuthStrategy ? ' (default)' : ''}`,
        value: type,
      })),
      default: provider.defaultAuthStrategy,
    })
    strategy = { type } as AuthStrategy
  }
  strategy ??= { type: provider.defaultAuthStrategy } as AuthStrategy

  const controller = new AbortController()
  const cancel = () => controller.abort()
  process.once('SIGINT', cancel)
  try {
    const credential = await provider.auth.login({
      strategy: strategy as never,
      signal: controller.signal,
    })
    await persistProviderCredential(provider.sensosId, credential)
  } finally {
    process.removeListener('SIGINT', cancel)
  }
}
