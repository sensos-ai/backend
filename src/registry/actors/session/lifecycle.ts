import { isAbsolute, resolve } from 'node:path'
import { AgentOs, createHostDirBackend } from '@rivet-dev/agentos'
import { resolveHarnessFeatures } from '@/lib/harness'
import {
  configuredSessionCatalog,
  updateCatalogTitle,
} from '@/sensos/catalog'
import { DEFAULT_WORKSPACE_PATH } from '@/lib/harness/constants'
import {
  ensureSessionMeta,
  getSessionMeta,
  listMessages,
  replaceMessages,
  setSessionTitle,
} from './db'
import { generateSessionTitle, userMessageText } from './title'
import { sessionInputSchema } from './types'
import type {
  CreateState,
  CreateConnState,
  CreateVars,
  OnDestroy,
  OnSleep,
  OnCreate,
  OnWake,
  OnConnect,
} from './types'

const AGENTOS_SOFTWARE_ENV = 'SENSOS_AGENTOS_SOFTWARE_PATHS'

export function parseAgentOsSoftwarePaths(
  raw: string | undefined
): { packagePath: string }[] | undefined {
  if (raw === undefined) return undefined

  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw new Error(
      `${AGENTOS_SOFTWARE_ENV} must be a JSON string array`,
      {
        cause: error,
      }
    )
  }

  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(path => typeof path !== 'string' || !isAbsolute(path))
  ) {
    throw new Error(
      `${AGENTOS_SOFTWARE_ENV} must contain at least one absolute package path`
    )
  }

  return value.map(packagePath => ({ packagePath }))
}

export const createState: CreateState = (context, rawInput) => {
  const input = sessionInputSchema.parse(rawInput)
  const sessionId = input.sessionId ?? context.key?.[0]
  if (!sessionId) throw new Error('Session id is required')

  return {
    sessionId,
    catalogRevision: input.catalogRevision ?? 0,
    title: undefined,
    initialMessages: input.initialMessages ?? [],
    config: {
      hostCwd: resolve(input.cwd),
      guestCwd: DEFAULT_WORKSPACE_PATH,
      model: input.model,
      instructions: input.instructions,
      features: resolveHarnessFeatures(input.features),
    },
  }
}

type TitleLifecycleContext =
  | Parameters<OnCreate>[0]
  | Parameters<OnWake>[0]
  | Parameters<OnConnect>[0]

function scheduleMissingSessionTitle(
  context: TitleLifecycleContext
): void {
  context.waitUntil(
    (async () => {
      const [meta, messages] = await Promise.all([
        getSessionMeta(context.db),
        listMessages(context.db),
      ])
      const existingTitle = meta.title ?? context.state.title
      if (existingTitle) {
        context.state.title = existingTitle
        return
      }

      const prompt = messages
        .map(userMessageText)
        .find((value): value is string => value !== undefined)
      if (!prompt) return

      const title = await generateSessionTitle(prompt, {
        features: context.state.config.features,
      })
      if (!title || context.state.title) return

      const catalog = configuredSessionCatalog()
      const session = catalog
        ? await updateCatalogTitle(
            catalog,
            context.state.sessionId,
            context.state.catalogRevision,
            title
          )
        : undefined
      context.state.title = session?.title ?? title
      if (session) context.state.catalogRevision = session.revision
      await Promise.all([
        setSessionTitle(context.db, context.state.title),
        context.saveState({ immediate: true }),
      ])
      context.broadcast('titleChanged', { title: context.state.title })
    })().catch(error => {
      context.log.warn({
        msg: 'session title generation failed',
        error: error instanceof Error ? error.message : String(error),
      })
    })
  )
}

export const onCreate: OnCreate = async (context, _input) => {
  const catalog = configuredSessionCatalog()
  if (catalog) {
    const session = await catalog.bindActor(
      context.state.sessionId,
      context.actorId,
      context.state.config.hostCwd
    )
    context.state.catalogRevision = session.revision
    context.state.title = session.title ?? undefined
  }
  await ensureSessionMeta(context.db)
  if (context.state.title) {
    await setSessionTitle(context.db, context.state.title)
  }
  if (context.state.initialMessages.length) {
    const revision = await replaceMessages(
      context.db,
      context.state.initialMessages
    )
    await catalog?.replaceMessages(
      context.state.sessionId,
      revision,
      context.state.initialMessages
    )
  }
  scheduleMissingSessionTitle(context)
}

export const onWake: OnWake = async context => {
  const catalog = configuredSessionCatalog()
  const [meta, messages] = await Promise.all([
    getSessionMeta(context.db),
    listMessages(context.db),
  ])
  if (catalog) {
    await catalog.replaceMessages(
      context.state.sessionId,
      meta.revision,
      messages
    )
    let session = await catalog.get(context.state.sessionId)
    if (!session || session.deletedAt) return
    if (
      session.actorId !== context.actorId ||
      session.cwd !== context.state.config.hostCwd
    ) {
      session = await catalog.bindActor(
        context.state.sessionId,
        context.actorId,
        context.state.config.hostCwd
      )
    }
    if (session.revision > context.state.catalogRevision) {
      context.state.catalogRevision = session.revision
      context.state.title = session.title ?? undefined
      if (session.title) await setSessionTitle(context.db, session.title)
    }
  }
  scheduleMissingSessionTitle(context)
}

export const onConnect: OnConnect = context => {
  const catalog = configuredSessionCatalog()
  if (catalog)
    context.waitUntil(catalog.markOpened(context.state.sessionId))
  scheduleMissingSessionTitle(context)
}

export const createVars: CreateVars = async context => {
  const software = parseAgentOsSoftwarePaths(
    process.env[AGENTOS_SOFTWARE_ENV]
  )

  return {
    vm: await AgentOs.create({
      ...(software ? { defaultSoftware: false, software } : {}),
      mounts: [
        {
          path: context.state.config.guestCwd,
          plugin: createHostDirBackend({
            hostPath: context.state.config.hostCwd,
            readOnly: false,
          }),
          readOnly: false,
        },
      ],
    }),
    activeRun: undefined,
  }
}

export const createConnState: CreateConnState = (_context, params) => ({
  clientId: params.clientId,
  userId: undefined,
})

export const onSleep: OnSleep = async context => {
  context.vars.activeRun?.abortController.abort()
  await context.vars.vm.dispose()
}

export const onDestroy: OnDestroy = async context => {
  context.vars.activeRun?.abortController.abort()
  await Promise.all([
    context.vars.vm.dispose(),
    configuredSessionCatalog()?.tombstone(context.state.sessionId),
  ])
}
