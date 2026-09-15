import { hostname } from 'node:os'

const CLIENT_ID = 'cl_HYyOPBNtFMfHhaUn9L4QPfTZz6TP47bp'
const ISSUER = 'https://vercel.com/'
const TEAMS_URL = 'https://api.vercel.com/v2/teams?limit=100'
const USER_URL = 'https://api.vercel.com/v2/user'

export type VercelOAuthCredential = {
  accessToken: string
  refreshToken?: string
  expiresAt: number
}

export type VercelTeam = { id: string; name: string }

export type VercelUser = {
  name: string
  email: string
  affiliation?: {
    kind: 'team'
    name: string
  }
}

export type VercelUserCredential = VercelOAuthCredential & {
  teamId?: string
}

export type OAuthFetch = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>

type DeviceAuthorization = {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete: string
  expires_in: number
  interval: number
}

type TokenResponse = {
  access_token: string
  refresh_token?: string
  expires_in: number
}

type AuthorizationServer = {
  device_authorization_endpoint: string
  token_endpoint: string
}

function userAgent() {
  return `sensos ${hostname()}`
}

async function authorizationServer(
  signal?: AbortSignal,
  fetchImpl: OAuthFetch = fetch
): Promise<AuthorizationServer> {
  const response = await fetchImpl(
    new URL('.well-known/openid-configuration', ISSUER),
    {
      headers: { 'user-agent': userAgent() },
      signal,
    }
  )
  const value = (await response.json()) as Partial<AuthorizationServer>
  if (
    !response.ok ||
    !value.device_authorization_endpoint ||
    !value.token_endpoint
  ) {
    throw new Error('Could not load Vercel OAuth configuration.')
  }
  return value as AuthorizationServer
}

export async function getVercelUser(
  credential: VercelUserCredential,
  fetchImpl: OAuthFetch = fetch
): Promise<VercelUser> {
  const headers = {
    authorization: `Bearer ${credential.accessToken}`,
    'user-agent': userAgent(),
  }
  const [userResponse, teamResponse] = await Promise.all([
    fetchImpl(USER_URL, { headers }),
    credential.teamId
      ? fetchImpl(`https://api.vercel.com/v2/teams/${credential.teamId}`, {
          headers,
        })
      : undefined,
  ])
  const userValue = (await userResponse.json()) as {
    user?: { name?: unknown; username?: unknown; email?: unknown }
  }
  if (
    !userResponse.ok ||
    typeof userValue.user?.email !== 'string' ||
    typeof (userValue.user.name ?? userValue.user.username) !== 'string'
  ) {
    if (userResponse.status === 401 || userResponse.status === 403) {
      throw new Error(
        'Vercel login expired. Run `sensos login vercel` again.'
      )
    }
    throw new Error(`Could not load Vercel user (${userResponse.status}).`)
  }

  let teamName: string | undefined
  if (teamResponse) {
    const teamValue = (await teamResponse.json()) as { name?: unknown }
    if (!teamResponse.ok) {
      throw new Error(
        `Could not load Vercel team (${teamResponse.status}).`
      )
    }
    if (typeof teamValue.name === 'string') teamName = teamValue.name
  }
  return {
    name: String(userValue.user.name ?? userValue.user.username),
    email: userValue.user.email,
    ...(teamName
      ? { affiliation: { kind: 'team' as const, name: teamName } }
      : {}),
  }
}

export async function beginVercelLogin(
  signal?: AbortSignal,
  fetchImpl: OAuthFetch = fetch
) {
  const server = await authorizationServer(signal, fetchImpl)
  const response = await fetchImpl(server.device_authorization_endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': userAgent(),
    },
    body: new URLSearchParams({
      client_id: process.env.SENSOS_VERCEL_CLIENT_ID ?? CLIENT_ID,
      scope: 'openid offline_access',
    }),
    signal,
  })
  if (!response.ok) {
    throw new Error(`Vercel login could not start (${response.status}).`)
  }
  const device = (await response.json()) as Partial<DeviceAuthorization>
  if (
    !device.device_code ||
    !device.user_code ||
    !device.verification_uri ||
    !device.verification_uri_complete ||
    typeof device.expires_in !== 'number' ||
    typeof device.interval !== 'number'
  ) {
    throw new Error(
      'Vercel returned an invalid device authorization response.'
    )
  }
  return device as DeviceAuthorization
}

export async function completeVercelLogin(
  device: DeviceAuthorization,
  signal?: AbortSignal,
  fetchImpl: OAuthFetch = fetch,
  sleep: (milliseconds: number) => Promise<void> = Bun.sleep
): Promise<VercelOAuthCredential> {
  const server = await authorizationServer(signal, fetchImpl)
  const deadline = Date.now() + device.expires_in * 1000
  let delay = device.interval * 1000
  while (Date.now() < deadline) {
    const response = await fetchImpl(server.token_endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': userAgent(),
      },
      body: new URLSearchParams({
        client_id: process.env.SENSOS_VERCEL_CLIENT_ID ?? CLIENT_ID,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: device.device_code,
      }),
      signal,
    })
    const value = (await response.json()) as Partial<TokenResponse> & {
      error?: string
    }
    if (
      response.ok &&
      value.access_token &&
      typeof value.expires_in === 'number'
    ) {
      return {
        accessToken: value.access_token,
        ...(value.refresh_token
          ? { refreshToken: value.refresh_token }
          : {}),
        expiresAt: Date.now() + value.expires_in * 1000,
      }
    }
    if (value.error === 'authorization_pending') {
      await sleep(delay)
      continue
    }
    if (value.error === 'slow_down') {
      delay += 5_000
      await sleep(delay)
      continue
    }
    throw new Error(
      `Vercel login failed${value.error ? `: ${value.error}` : '.'}`
    )
  }
  throw new Error('Vercel login expired. Run `sensos login` again.')
}

export async function refreshVercelCredential(
  credential: VercelOAuthCredential,
  fetchImpl: OAuthFetch = fetch
): Promise<VercelOAuthCredential> {
  if (!credential.refreshToken) {
    throw new Error(
      'Vercel login expired. Run `sensos login vercel` again.'
    )
  }
  const server = await authorizationServer(undefined, fetchImpl)
  const response = await fetchImpl(server.token_endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': userAgent(),
    },
    body: new URLSearchParams({
      client_id: process.env.SENSOS_VERCEL_CLIENT_ID ?? CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: credential.refreshToken,
    }),
  })
  const value = (await response.json()) as Partial<TokenResponse>
  if (
    !response.ok ||
    typeof value.access_token !== 'string' ||
    typeof value.expires_in !== 'number'
  ) {
    throw new Error(
      'Vercel login expired. Run `sensos login vercel` again.'
    )
  }
  return {
    accessToken: value.access_token,
    refreshToken: value.refresh_token ?? credential.refreshToken,
    expiresAt: Date.now() + value.expires_in * 1000,
  }
}

export async function listVercelTeams(
  accessToken: string,
  signal?: AbortSignal,
  fetchImpl: OAuthFetch = fetch
): Promise<VercelTeam[]> {
  const response = await fetchImpl(TEAMS_URL, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      'user-agent': userAgent(),
    },
    signal,
  })
  if (!response.ok)
    throw new Error(`Could not list Vercel teams (${response.status}).`)
  const value = (await response.json()) as {
    teams?: Array<{ id?: unknown; name?: unknown; slug?: unknown }>
  }
  return (value.teams ?? []).flatMap(team =>
    typeof team.id === 'string' &&
    typeof (team.name ?? team.slug) === 'string'
      ? [{ id: team.id, name: String(team.name ?? team.slug) }]
      : []
  )
}
