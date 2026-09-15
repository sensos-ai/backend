import { AsyncEntry, type EntryOptions } from '@napi-rs/keyring'

if (process.env.SENSOS_KEYRING_SMOKE !== '1') {
  console.error(
    'Set SENSOS_KEYRING_SMOKE=1 to run the native credential-store smoke test.'
  )
  process.exit(1)
}

const service = `dev.sensos.smoke.${crypto.randomUUID()}`
const account = `credential-${crypto.randomUUID()}`
const secret = crypto.randomUUID()
const options: EntryOptions | undefined =
  process.platform === 'linux'
    ? { linux: { store: 'secret-service' } }
    : undefined
const entry = new AsyncEntry(service, account, options)
let failure: unknown
let cleanupFailure: unknown

try {
  await entry.setPassword(secret)
  const stored = await entry.getPassword()
  if (stored !== secret) throw new Error('Credential round-trip failed.')
} catch (error) {
  failure = error
} finally {
  try {
    await entry.deleteCredential()
  } catch (cleanupError) {
    console.error(
      `Could not clean up native keyring smoke credential ${service}/${account}.`
    )
    cleanupFailure = cleanupError
  }
}

if (cleanupFailure) throw cleanupFailure
if (failure) throw failure
console.log(`Native keyring smoke passed for ${service}/${account}.`)
