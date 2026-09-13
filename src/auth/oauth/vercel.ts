import { hostname } from 'node:os'

const CLIENT_ID = 'cl_HYyOPBNtFMfHhaUn9L4QPfTZz6TP47bp'
const ISSUER = 'https://vercel.com/'
const TEAMS_URL = 'https://api.vercel.com/v2/teams?limit=100'

export type VercelOAuthCredential = {
  accessToken: string
  refreshToken?: string
  expiresAt: number
}

export type VercelTeam = { id: string; name: string }

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
  signal?: AbortSignal
): Promise<AuthorizationServer> {
  const response = await fetch(
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

export async function beginVercelLogin(signal?: AbortSignal) {
  const server = await authorizationServer(signal)
  const response = await fetch(server.device_authorization_endpoint, {
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
  signal?: AbortSignal
): Promise<VercelOAuthCredential> {
  const server = await authorizationServer(signal)
  const deadline = Date.now() + device.expires_in * 1000
  let delay = device.interval * 1000
  while (Date.now() < deadline) {
    const response = await fetch(server.token_endpoint, {
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
      await Bun.sleep(delay)
      continue
    }
    if (value.error === 'slow_down') {
      delay += 5_000
      await Bun.sleep(delay)
      continue
    }
    throw new Error(
      `Vercel login failed${value.error ? `: ${value.error}` : '.'}`
    )
  }
  throw new Error('Vercel login expired. Run `sensos login` again.')
}

export async function listVercelTeams(
  accessToken: string,
  signal?: AbortSignal
): Promise<VercelTeam[]> {
  const response = await fetch(TEAMS_URL, {
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
