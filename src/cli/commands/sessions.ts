import { checkbox, select } from '@inquirer/prompts'
import type { SessionCatalog } from '@/storage/session-catalog'

export type LocalSession = {
  actorId?: string
  sessionId: string
  title?: string
  updatedAt?: number
}

export async function listLocalSessions(
  catalog: SessionCatalog,
  cwd?: string
): Promise<LocalSession[]> {
  return (await catalog.list(cwd)).map(session => ({
    actorId: session.actorId ?? undefined,
    sessionId: session.sessionId,
    title: session.title ?? undefined,
    updatedAt: session.updatedAt,
  }))
}

export function formatLocalSessions(sessions: LocalSession[]): string {
  return sessions
    .map(session => {
      if (!session.title) return session.sessionId
      return `${session.title}\n  ${session.sessionId}`
    })
    .join('\n')
}

export async function pickLocalSession(
  sessions: LocalSession[],
  picker: typeof select = select
): Promise<string | undefined> {
  if (sessions.length === 0) return undefined
  return picker({
    message: 'Select a session',
    choices: sessions.map(session => ({
      name: session.title ?? session.sessionId,
      value: session.sessionId,
      description: session.title
        ? session.sessionId
        : 'Title pending or unavailable',
    })),
  })
}

export async function pickLocalSessions(
  sessions: LocalSession[],
  picker: typeof checkbox = checkbox
): Promise<LocalSession[]> {
  if (sessions.length === 0) return []
  const selectedIds = await picker({
    message: 'Select sessions to delete',
    choices: sessions.map(session => ({
      name: session.title ?? session.sessionId,
      value: session.sessionId,
      description: session.title
        ? session.sessionId
        : 'Title pending or unavailable',
    })),
  })
  const selected = new Set(selectedIds)
  return sessions.filter(session => selected.has(session.sessionId))
}

export function deleteSessionsConfirmationMessage(
  sessions: LocalSession[]
): string {
  if (sessions.length === 1) {
    const session = sessions[0]
    return `Are you sure you want to delete session ${session?.title ?? session?.sessionId}?`
  }
  return `Are you sure you want to delete ${sessions.length} sessions?`
}
