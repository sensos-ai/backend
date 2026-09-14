import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { openSessionCatalog } from '@/storage/session-catalog'

test('catalog reserves, revises, tombstones, and purges sessions', async () => {
  const directory = await mkdtemp('/tmp/sensos-catalog-')
  try {
    const catalog = openSessionCatalog(join(directory, 'catalog.sqlite'))
    const reserved = await catalog.reserve({
      sessionId: 'chat_one',
      cwd: '/workspace/one',
    })
    expect(reserved).toMatchObject({
      sessionId: 'chat_one',
      cwd: '/workspace/one',
      revision: 1,
    })

    const initialMessages = [
      {
        id: 'msg_one',
        role: 'user' as const,
        parts: [{ type: 'text' as const, text: 'hello' }],
      },
    ]
    expect(
      await catalog.replaceMessages('chat_one', 1, initialMessages)
    ).toBe(true)
    expect(await catalog.getMessages('chat_one')).toEqual(initialMessages)
    expect(await catalog.replaceMessages('chat_one', 0, [])).toBe(false)
    expect(await catalog.getMessages('chat_one')).toEqual(initialMessages)

    const bound = await catalog.bindActor('chat_one', 'actor_one')
    const titled = await catalog.update('chat_one', bound.revision, {
      title: 'Catalog title',
    })
    await catalog.markOpened('chat_one')
    expect(await catalog.list()).toEqual([
      expect.objectContaining({
        sessionId: 'chat_one',
        actorId: 'actor_one',
        title: 'Catalog title',
        revision: titled.revision,
        lastOpenedAt: expect.any(Number),
      }),
    ])
    expect(await catalog.list('/workspace/one')).toHaveLength(1)
    expect(await catalog.list('/workspace/two')).toEqual([])

    await catalog.tombstone('chat_one')
    expect(await catalog.list()).toEqual([])
    expect((await catalog.get('chat_one'))?.deletedAt).toEqual(
      expect.any(Number)
    )
    await catalog.purge(['chat_one'])
    expect(await catalog.get('chat_one')).toBeUndefined()
    expect(await catalog.getMessages('chat_one')).toEqual([])
    catalog.close()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
