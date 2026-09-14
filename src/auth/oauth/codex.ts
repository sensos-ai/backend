import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const AUTH_BASE_URL = 'https://auth.openai.com'
const REDIRECT_URI = 'http://localhost:1455/auth/callback'

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
