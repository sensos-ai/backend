import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const AUTH_BASE_URL = 'https://auth.openai.com'
const REDIRECT_URI = 'http://localhost:1455/auth/callback'
const DEVICE_REDIRECT_PATH = '/deviceauth/callback'
const DEVICE_AUTH_TIMEOUT_MS = 15 * 60 * 1000

export type CodexOAuthCredential = {
  accessToken: string
  refreshToken: string
  expiresAt: number
  accountId: string
}

export type CodexUser = {
  name: string
  email: string
  affiliation?: {
    kind: 'organization'
    name: string
  }
}

export type CodexAuthFetch = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>

export type CodexDeviceLoginOptions = {
  onDeviceCode: (
    verificationUrl: string,
    userCode: string
  ) => void | Promise<void>
  signal?: AbortSignal
  fetch?: CodexAuthFetch
  authBaseUrl?: string
  now?: () => number
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>
}

export async function getCodexUser(
  credential: CodexOAuthCredential,
  fetchImpl: CodexAuthFetch = fetch
): Promise<CodexUser> {
  const response = await fetchImpl('https://chatgpt.com/backend-api/me', {
    headers: {
      Authorization: `Bearer ${credential.accessToken}`,
      'chatgpt-account-id': credential.accountId,
    },
  })
  const value = (await response.json()) as {
    name?: unknown
    email?: unknown
    orgs?: {
      data?: Array<{
        title?: unknown
        name?: unknown
        is_default?: unknown
      }>
    }
  }
  if (
    !response.ok ||
    typeof value.name !== 'string' ||
    typeof value.email !== 'string'
  ) {
    throw new Error(`Could not load Codex user (${response.status}).`)
  }
  const organizations = value.orgs?.data ?? []
  const organization =
    organizations.find(candidate => candidate.is_default === true) ??
    organizations[0]
  const organizationName = organization?.title ?? organization?.name
  return {
    name: value.name,
    email: value.email,
    ...(typeof organizationName === 'string'
      ? {
          affiliation: {
            kind: 'organization' as const,
            name: organizationName,
          },
        }
      : {}),
  }
}

export async function refreshCodexCredential(
  credential: CodexOAuthCredential,
  fetchImpl: CodexAuthFetch = fetch
): Promise<CodexOAuthCredential> {
  const response = await fetchImpl(`${AUTH_BASE_URL}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: process.env.SENSOS_CODEX_CLIENT_ID ?? CLIENT_ID,
      refresh_token: credential.refreshToken,
    }),
  })
  const token = (await response.json()) as {
    access_token?: unknown
    refresh_token?: unknown
    expires_in?: unknown
  }
  if (
    !response.ok ||
    typeof token.access_token !== 'string' ||
    typeof token.expires_in !== 'number'
  ) {
    throw new Error(
      'OpenAI Codex login expired. Run `sensos login codex` again.'
    )
  }
  return {
    accessToken: token.access_token,
    refreshToken:
      typeof token.refresh_token === 'string'
        ? token.refresh_token
        : credential.refreshToken,
    expiresAt: Date.now() + token.expires_in * 1000,
    accountId: accountId(token.access_token),
  }
}

function accountId(accessToken: string): string {
  const payload = accessToken.split('.')[1]
  if (!payload)
    throw new Error('OpenAI Codex returned an invalid access token.')
  const value = JSON.parse(
    Buffer.from(payload, 'base64url').toString('utf8')
  ) as {
    'https://api.openai.com/auth'?: { chatgpt_account_id?: unknown }
  }
  const id = value['https://api.openai.com/auth']?.chatgpt_account_id
  if (typeof id !== 'string' || !id) {
    throw new Error(
      'OpenAI Codex access token is missing its ChatGPT account ID.'
    )
  }
  return id
}

function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('OpenAI Codex login cancelled.'))
      return
    }
    const timeout = setTimeout(finish, milliseconds)
    const onAbort = () => {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
      reject(new Error('OpenAI Codex login cancelled.'))
    }
    function finish() {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export async function loginWithCodexDevice(
  options: CodexDeviceLoginOptions
): Promise<CodexOAuthCredential> {
  const fetchImpl = options.fetch ?? fetch
  const authBaseUrl = (options.authBaseUrl ?? AUTH_BASE_URL).replace(
    /\/$/,
    ''
  )
  const clientId = process.env.SENSOS_CODEX_CLIENT_ID ?? CLIENT_ID
  const response = await fetchImpl(
    `${authBaseUrl}/api/accounts/deviceauth/usercode`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: clientId }),
      signal: options.signal,
    }
  )
  const device = (await response.json()) as {
    device_auth_id?: unknown
    user_code?: unknown
    interval?: unknown
  }
  const interval =
    typeof device.interval === 'string'
      ? Number(device.interval.trim())
      : device.interval
  if (
    !response.ok ||
    typeof device.device_auth_id !== 'string' ||
    typeof device.user_code !== 'string' ||
    typeof interval !== 'number' ||
    !Number.isFinite(interval) ||
    interval < 0
  ) {
    throw new Error(
      `OpenAI Codex device code request failed (${response.status}).`
    )
  }

  await options.onDeviceCode(
    `${authBaseUrl}/codex/device`,
    device.user_code
  )
  const now = options.now ?? Date.now
  const wait = options.sleep ?? sleep
  const deadline = now() + DEVICE_AUTH_TIMEOUT_MS
  let authorization:
    | { authorization_code: string; code_verifier: string }
    | undefined
  while (now() < deadline) {
    const poll = await fetchImpl(
      `${authBaseUrl}/api/accounts/deviceauth/token`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          device_auth_id: device.device_auth_id,
          user_code: device.user_code,
        }),
        signal: options.signal,
      }
    )
    if (poll.ok) {
      const value = (await poll.json()) as {
        authorization_code?: unknown
        code_verifier?: unknown
      }
      if (
        typeof value.authorization_code !== 'string' ||
        typeof value.code_verifier !== 'string'
      ) {
        throw new Error(
          'OpenAI Codex returned an incomplete device authorization.'
        )
      }
      authorization = {
        authorization_code: value.authorization_code,
        code_verifier: value.code_verifier,
      }
      break
    }
    if (poll.status !== 403 && poll.status !== 404) {
      throw new Error(`OpenAI Codex device login failed (${poll.status}).`)
    }
    await wait(Math.min(interval * 1000, deadline - now()), options.signal)
  }
  if (!authorization) {
    throw new Error(
      'OpenAI Codex device login timed out after 15 minutes.'
    )
  }

  const tokenResponse = await fetchImpl(`${authBaseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code: authorization.authorization_code,
      code_verifier: authorization.code_verifier,
      redirect_uri: `${authBaseUrl}${DEVICE_REDIRECT_PATH}`,
    }),
    signal: options.signal,
  })
  const token = (await tokenResponse.json()) as {
    access_token?: unknown
    refresh_token?: unknown
    expires_in?: unknown
  }
  if (
    !tokenResponse.ok ||
    typeof token.access_token !== 'string' ||
    typeof token.refresh_token !== 'string' ||
    typeof token.expires_in !== 'number'
  ) {
    throw new Error(
      'OpenAI Codex returned an incomplete OAuth credential.'
    )
  }
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: Date.now() + token.expires_in * 1000,
    accountId: accountId(token.access_token),
  }
}

function waitForCallback(
  state: string,
  signal?: AbortSignal
): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', REDIRECT_URI)
      const code = url.searchParams.get('code')
      if (
        url.pathname !== '/auth/callback' ||
        !code ||
        url.searchParams.get('state') !== state
      ) {
        response
          .writeHead(400)
          .end('OpenAI Codex login failed. Return to Sensos.')
        finish(new Error('OpenAI Codex OAuth callback was invalid.'))
        return
      }
      response
        .writeHead(200)
        .end('OpenAI Codex login complete. Return to Sensos.')
      finish(undefined, code)
    })
    let settled = false
    const finish = (error?: Error, code?: string) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      if (server.listening) server.close()
      error ? reject(error) : resolve(code as string)
    }
    const onAbort = () =>
      finish(new Error('OpenAI Codex login cancelled.'))
    server.once('error', error => finish(error))
    signal?.addEventListener('abort', onAbort, { once: true })
    server.listen(1455, '127.0.0.1')
  })
}

export async function loginWithCodex(
  openUrl: (url: string) => Promise<void>,
  signal?: AbortSignal
): Promise<CodexOAuthCredential> {
  const loginController = new AbortController()
  const loginSignal = signal
    ? AbortSignal.any([signal, loginController.signal])
    : loginController.signal
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256')
    .update(verifier)
    .digest('base64url')
  const state = randomBytes(16).toString('hex')
  const url = new URL(`${AUTH_BASE_URL}/oauth/authorize`)
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.SENSOS_CODEX_CLIENT_ID ?? CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: 'openid profile email offline_access',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    originator: 'sensos',
  }).toString()
  const callback = waitForCallback(state, loginSignal)
  try {
    await openUrl(url.toString())
    const code = await callback
    const response = await fetch(`${AUTH_BASE_URL}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: process.env.SENSOS_CODEX_CLIENT_ID ?? CLIENT_ID,
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT_URI,
      }),
      signal: loginSignal,
    })
    const token = (await response.json()) as {
      access_token?: unknown
      refresh_token?: unknown
      expires_in?: unknown
    }
    if (
      !response.ok ||
      typeof token.access_token !== 'string' ||
      typeof token.refresh_token !== 'string' ||
      typeof token.expires_in !== 'number'
    ) {
      throw new Error(
        'OpenAI Codex returned an incomplete OAuth credential.'
      )
    }
    return {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: Date.now() + token.expires_in * 1000,
      accountId: accountId(token.access_token),
    }
  } finally {
    loginController.abort()
    await callback.catch(() => undefined)
  }
}
