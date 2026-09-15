import { select } from '@inquirer/prompts'
import {
  createHarnessAuthRegistry,
  createHarnessProviderRegistry,
  harnessAuthKeys,
  type HarnessAuthKey,
} from '@/chat/harness/providers'
import {
  clearProviderCredential,
  readProviderProfile,
  readProviderProfileWithCredential,
} from '@/auth/profile'
import type { CliState } from '@/cli/state'
import type { LogoutRequest } from './parse'

export async function runLogout(
  request: LogoutRequest,
  state: CliState
): Promise<void> {
  const profile = await readProviderProfile()
  const providers = createHarnessProviderRegistry(profile.credentials)
  const auth = createHarnessAuthRegistry(providers)
  let authKey = request.provider
  if (!authKey) {
    const stored = harnessAuthKeys(providers).filter(
      key =>
        profile.credentials[auth[key].sensosId] !== undefined ||
        profile.credentialBackends[auth[key].sensosId] === 'keyring'
    )
    if (!state.isInteractive)
      throw new Error(
        `Usage: sensos auth logout <${harnessAuthKeys(providers).join('|')}>`
      )
    if (stored.length === 0)
      throw new Error('No stored provider credentials.')
    authKey = await select({
      message: 'Choose a provider to sign out',
      choices: stored.map(key => ({
        name: auth[key].displayName,
        value: key,
      })),
    })
  }
  const provider = auth[authKey as HarnessAuthKey]
  const credential = (
    await readProviderProfileWithCredential(provider.sensosId)
  ).credentials[provider.sensosId]
  if (credential) await provider.auth.logout?.(credential as never)
  await clearProviderCredential(provider.sensosId)
  console.log(`Signed out of ${authKey}.`)
}
