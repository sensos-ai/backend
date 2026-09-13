import { describe, expect, test } from 'bun:test'
import {
  deleteSessionsConfirmationMessage,
  listLocalSessions,
  pickLocalSession,
  pickLocalSessions,
} from '@/cli/commands/sessions'
import {
  deleteLocalSessionActor,
  waitForLocalSessionDeletion,
} from '@/runtime/sessions'
import type { SessionCatalog } from '@/storage/session-catalog'

describe('saved session picker', () => {
  test('lists active sessions directly from the catalog', async () => {
    const catalog = {
      list: async () => [
        {
          actorId: 'actor_1',
          sessionId: 'chat_one',
          cwd: '/workspace',
          title: 'First chat',
          createdAt: 1,
          updatedAt: 2,
          lastOpenedAt: null,
          deletedAt: null,
          revision: 1,
          transcriptRevision: 0,
        },
      ],
    } as SessionCatalog
    expect(await listLocalSessions(catalog, '/workspace')).toEqual([
      {
        actorId: 'actor_1',
        sessionId: 'chat_one',
        title: 'First chat',
        updatedAt: 2,
      },
    ])
  })

  test('returns cleanly when there are no sessions', async () => {
    expect(await pickLocalSession([])).toBeUndefined()
  })

  test('uses the title as the picker label and returns its session id', async () => {
    const picker = (async options => {
      expect(options.choices?.[0]).toMatchObject({
        name: 'Fix actor lifecycle',
        value: 'chat_one',
        description: 'chat_one',
      })
      return 'chat_one'
    }) as Parameters<typeof pickLocalSession>[1]
    expect(
      await pickLocalSession(
        [
          {
            actorId: 'actor_1',
            sessionId: 'chat_one',
            title: 'Fix actor lifecycle',
          },
        ],
        picker
      )
    ).toBe('chat_one')
  })

  test('supports selecting one or more sessions for deletion', async () => {
    const sessions = [
      {
        actorId: 'actor_1',
        sessionId: 'chat_one',
        title: 'First chat',
      },
      { actorId: 'actor_2', sessionId: 'chat_two' },
    ]
    const picker = (async (options: { choices?: readonly unknown[] }) => {
      expect(options.choices).toEqual([
        {
          name: 'First chat',
          value: 'chat_one',
          description: 'chat_one',
        },
        {
          name: 'chat_two',
          value: 'chat_two',
          description: 'Title pending or unavailable',
        },
      ])
      return ['chat_one', 'chat_two']
    }) as unknown as Parameters<typeof pickLocalSessions>[1]

    expect(await pickLocalSessions(sessions, picker)).toEqual(sessions)
  })

  test('formats single and bulk deletion confirmations', () => {
    expect(
      deleteSessionsConfirmationMessage([
        {
          actorId: 'actor_1',
          sessionId: 'chat_one',
          title: 'First chat',
        },
      ])
    ).toBe('Are you sure you want to delete session First chat?')
    expect(
      deleteSessionsConfirmationMessage([
        { actorId: 'actor_1', sessionId: 'chat_one' },
        { actorId: 'actor_2', sessionId: 'chat_two' },
      ])
    ).toBe('Are you sure you want to delete 2 sessions?')
  })

  test('waits until a destroyed session is absent', async () => {
    let requests = 0
    await waitForLocalSessionDeletion('http://localhost', 'chat_one', {
      pollIntervalMs: 0,
      fetcher: async () => {
        requests += 1
        return Response.json({
          actors:
            requests === 1
              ? [{ actor_id: 'actor_1', key: 'chat_one' }]
              : [
                  {
                    actor_id: 'actor_1',
                    key: 'chat_one',
                    destroy_ts: 1,
                  },
                ],
        })
      },
    })

    expect(requests).toBe(2)
  })

  test('deletes the matching actor through the Rivet control plane', async () => {
    const requests: { url: string; method?: string }[] = []
    await deleteLocalSessionActor(
      'http://localhost',
      'chat_one',
      async (url, init) => {
        requests.push({ url, method: init?.method })
        if (init?.method === 'DELETE') return Response.json({})
        return Response.json({
          actors: [{ actor_id: 'actor_1', key: 'chat_one' }],
        })
      }
    )

    expect(requests).toEqual([
      {
        url: 'http://localhost/actors?name=session&namespace=default',
        method: undefined,
      },
      {
        url: 'http://localhost/actors/actor_1?namespace=default',
        method: 'DELETE',
      },
    ])
  })
})
