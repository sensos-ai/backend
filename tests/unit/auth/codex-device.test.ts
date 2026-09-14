import { expect, test } from 'bun:test'
import { loginWithCodexDevice } from '@/auth/oauth/codex'

function accessToken(accountId: string): string {
  return `header.${Buffer.from(
    JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_account_id: accountId },
    })
  ).toString('base64url')}.signature`
}

test('completes the Codex device authorization endpoint flow', async () => {
  const requests: Array<{ url: string; body: unknown }> = []
  let polls = 0
  const credential = await loginWithCodexDevice({
    authBaseUrl: 'https://auth.example.test',
    onDeviceCode: (verificationUrl, userCode) => {
      expect(verificationUrl).toBe(
        'https://auth.example.test/codex/device'
      )
      expect(userCode).toBe('ABCD-EFGH')
    },
    sleep: () => Promise.resolve(),
    fetch: async (input, init) => {
      const url = input.toString()
      const body =
        init?.body instanceof URLSearchParams
          ? Object.fromEntries(init.body)
          : JSON.parse(String(init?.body))
      requests.push({ url, body })

      if (url.endsWith('/api/accounts/deviceauth/usercode')) {
        return Response.json({
          device_auth_id: 'device-auth-id',
          user_code: 'ABCD-EFGH',
          interval: '1',
        })
      }
      if (url.endsWith('/api/accounts/deviceauth/token')) {
        polls += 1
        return polls === 1
          ? Response.json({}, { status: 403 })
          : Response.json({
              authorization_code: 'authorization-code',
              code_challenge: 'unused-by-client',
              code_verifier: 'code-verifier',
            })
      }
      if (url.endsWith('/oauth/token')) {
        return Response.json({
          access_token: accessToken('account-id'),
          refresh_token: 'refresh-token',
          expires_in: 3600,
        })
      }
      return Response.json({}, { status: 404 })
    },
  })

  expect(credential).toMatchObject({
    refreshToken: 'refresh-token',
    accountId: 'account-id',
  })
  expect(requests.map(request => request.url)).toEqual([
    'https://auth.example.test/api/accounts/deviceauth/usercode',
    'https://auth.example.test/api/accounts/deviceauth/token',
    'https://auth.example.test/api/accounts/deviceauth/token',
    'https://auth.example.test/oauth/token',
  ])
  expect(requests[0]?.body).toEqual({
    client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
  })
  expect(requests[1]?.body).toEqual({
    device_auth_id: 'device-auth-id',
    user_code: 'ABCD-EFGH',
  })
  expect(requests[3]?.body).toEqual({
    grant_type: 'authorization_code',
    client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
    code: 'authorization-code',
    code_verifier: 'code-verifier',
    redirect_uri: 'https://auth.example.test/deviceauth/callback',
  })
})
