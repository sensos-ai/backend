import type {
  AuthStrategy,
  HarnessAuthKey,
} from '@/chat/harness/providers'
import type { CredentialStoragePreference } from '@/auth/profile'

export type LoginRequest = {
  provider?: HarnessAuthKey
  strategy?: AuthStrategy
}
export type LogoutRequest = { provider?: HarnessAuthKey }
export type CredentialsConfigRequest = {
  storage?: CredentialStoragePreference
}

const isAuthKey = (
  value: string,
  keys: readonly HarnessAuthKey[]
): value is HarnessAuthKey => keys.includes(value as HarnessAuthKey)

export function parseLoginRequest(
  args: readonly string[],
  keys: readonly HarnessAuthKey[]
): LoginRequest {
  let provider: HarnessAuthKey | undefined
  let strategy: AuthStrategy | undefined
  for (let index = 0; index < args.length; index++) {
    const argument = args[index] as string
    if (argument === '--device') {
      if (strategy)
        throw new Error('Login strategy flags cannot be combined.')
      strategy = { type: 'oauth-device' }
      continue
    }
    if (argument === '--apiKey') {
      if (strategy)
        throw new Error('Login strategy flags cannot be combined.')
      const candidate = args[index + 1]
      if (candidate !== undefined && !candidate.startsWith('-')) {
        strategy = { type: 'apiKey', apiKey: candidate }
        index++
      } else {
        strategy = { type: 'apiKey' }
      }
      continue
    }
    if (argument.startsWith('-'))
      throw new Error(`Unknown login option: ${argument}`)
    if (provider) throw new Error('Login accepts only one provider.')
    if (!isAuthKey(argument, keys))
      throw new Error(`Unknown auth provider: ${argument}`)
    provider = argument
  }
  return {
    ...(provider ? { provider } : {}),
    ...(strategy ? { strategy } : {}),
  }
}

export function parseLogoutRequest(
  args: readonly string[],
  keys: readonly HarnessAuthKey[]
): LogoutRequest {
  if (args.length > 1) throw new Error('Logout accepts only one provider.')
  const provider = args[0]
  if (!provider) return {}
  if (provider.startsWith('-'))
    throw new Error(`Unknown logout option: ${provider}`)
  if (!isAuthKey(provider, keys))
    throw new Error(`Unknown auth provider: ${provider}`)
  return { provider }
}

export function parseCredentialsConfigRequest(
  args: readonly string[]
): CredentialsConfigRequest {
  if (args.length === 0) return {}
  if (args[0] !== '--storage' || args.length !== 2)
    throw new Error('Expected --storage <keyring|file|auto>.')
  const storage = args[1]
  if (storage !== 'keyring' && storage !== 'file' && storage !== 'auto')
    throw new Error(
      `Unknown credential storage preference: ${storage ?? ''}`
    )
  return { storage }
}
