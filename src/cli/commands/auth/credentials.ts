import { select } from '@inquirer/prompts'
import {
  configureCredentialStorage,
  readProviderProfile,
  resolveCredentialStorageBackend,
  type CredentialStoragePreference,
} from '@/auth/profile'
import type { CliState } from '@/cli/state'
import type { CredentialsConfigRequest } from './parse'

export async function runCredentialsConfig(
  request: CredentialsConfigRequest,
  state: CliState
): Promise<void> {
  const current = await readProviderProfile()
  let preference = request.storage
  if (!preference && state.isInteractive) {
    preference = await select<CredentialStoragePreference>({
      message: 'Credential storage',
      choices: (['keyring', 'file', 'auto'] as const).map(value => ({
        name: `${value}${value === current.storagePreference ? ' (current)' : ''}`,
        value,
      })),
      default: current.storagePreference,
    })
  }
  if (!preference) {
    console.log(
      `Credential storage preference: ${current.storagePreference}`
    )
    console.log(
      'Usage: sensos auth credentials config --storage <keyring|file|auto>'
    )
    return
  }
  const destination = await resolveCredentialStorageBackend(preference)
  const profile = await configureCredentialStorage(preference)
  console.log(
    `Credential storage preference: ${profile.storagePreference}`
  )
  console.log(`Credential backend: ${destination}`)
}
