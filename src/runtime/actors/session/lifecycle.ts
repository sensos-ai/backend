import { access, mkdir } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { AgentOs, createHostDirBackend } from '@rivet-dev/agentos'
import { resolveHarnessFeatures } from '@/chat/harness'
import { DEFAULT_WORKSPACE_PATH } from '@/chat/harness/constants'
import {
  ensureSessionMeta,
  getSessionMeta,
  listMessages,
  replaceMessages,
  setSessionTitle,
} from './db'
import { generateSessionTitle, userMessageText } from './title'
import { recoverOrphanedActiveRun } from './recovery'
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
import { normalizeLegacyModelRef } from '@/chat/harness/providers/model'
import { defaultModelRef } from '@/chat/harness/providers'
import { productStateDir } from '@/config/paths'
import { recordTiming } from '@/shared/timing'
import {
  negotiateProtocolVersion,
  SENSOS_PROTOCOL_VERSIONS,
} from '@sensos-ai/shared'

const AGENTOS_SOFTWARE_ENV = 'SENSOS_AGENTOS_SOFTWARE_PATHS'

type TitleLifecycleContext =
  | Parameters<OnCreate>[0]
  | Parameters<OnWake>[0]
  | Parameters<OnConnect>[0]

function migrateLegacySessionModel(context: TitleLifecycleContext): void {
  context.state.config.model = normalizeLegacyModelRef(
    context.state.config.model as
      | typeof context.state.config.model
      | string
  )
}

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
  const protocolVersion = negotiateProtocolVersion(
    input.supportedProtocolVersions
  )
  if (protocolVersion === undefined) {
    throw new Error(
      `UNSUPPORTED_PROTOCOL_VERSION: client offered ${input.supportedProtocolVersions.join(', ')}; server supports ${SENSOS_PROTOCOL_VERSIONS.join(', ')}`
    )
  }
  const sessionId = input.sessionId ?? context.key?.[0]
  if (!sessionId) throw new Error('Session id is required')

  return {
    protocolVersion,
    sessionId,
    catalogRevision: input.catalogRevision ?? 0,
    title: undefined,
    initialMessages: input.initialMessages ?? [],
    config: {
      hostCwd: resolve(input.cwd),
      guestCwd: DEFAULT_WORKSPACE_PATH,
      model: input.model ?? defaultModelRef('gateway'),
      instructions: input.instructions,
      features: resolveHarnessFeatures(input.features),
    },
  }
}

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
        provider: context.state.config.model?.provider,
      })
      if (!title || context.state.title) return

      context.state.title = title
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
  await ensureSessionMeta(context.db)
  if (context.state.title) {
    await setSessionTitle(context.db, context.state.title)
  }
  if (context.state.initialMessages.length) {
    await replaceMessages(context.db, context.state.initialMessages)
  }
  scheduleMissingSessionTitle(context)
}

export const onWake: OnWake = async context => {
  migrateLegacySessionModel(context)
  const persistedMeta = await getSessionMeta(context.db)
  await recoverOrphanedActiveRun({
    database: context.db,
    activeRunId: persistedMeta.activeRunId,
    liveRunId: context.vars.activeRun?.runId,
  })
  scheduleMissingSessionTitle(context)
}

export const onConnect: OnConnect = async context => {
  const startedAt = Date.now()
  recordTiming('actor.connect.start', {
    sessionId: context.state.sessionId,
  })
  migrateLegacySessionModel(context)
  const meta = await getSessionMeta(context.db)
  await recoverOrphanedActiveRun({
    database: context.db,
    activeRunId: meta.activeRunId,
    liveRunId: context.vars.activeRun?.runId,
  })
  scheduleMissingSessionTitle(context)
  recordTiming('actor.connect.ready', {
    sessionId: context.state.sessionId,
    elapsedMs: Date.now() - startedAt,
  })
}

export const createVars: CreateVars = async context => {
  const startedAt = Date.now()
  recordTiming('actor.agentos.start', {
    sessionId: context.state.sessionId,
    testModel: context.state.config.features.useMockModel,
  })
  const software = parseAgentOsSoftwarePaths(
    process.env[AGENTOS_SOFTWARE_ENV]
  )
  let hostPath = context.state.config.hostCwd
  if (context.state.config.features.useMockModel) {
    try {
      await access(hostPath)
    } catch {
      hostPath = join(
        productStateDir(),
        'test-workspaces',
        encodeURIComponent(context.state.sessionId)
      )
      await mkdir(hostPath, { recursive: true })
    }
  }

  const vm = await AgentOs.create({
    ...(software ? { defaultSoftware: false, software } : {}),
    mounts: [
      {
        path: context.state.config.guestCwd,
        plugin: createHostDirBackend({
          hostPath,
          readOnly: false,
        }),
        readOnly: false,
      },
    ],
  })
  recordTiming('actor.agentos.ready', {
    sessionId: context.state.sessionId,
    elapsedMs: Date.now() - startedAt,
  })

  return {
    vm,
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
  await context.vars.vm.dispose()
}
