import { confirm, select } from '@inquirer/prompts'
import { resolve } from 'node:path'
import type { ActorConn } from 'rivetkit/client'
import { configureDefaultLogger } from 'rivetkit/log'
import { DeferredSessionChatTransport } from '@/chat/transport'
import {
  resolveHarnessFeatures,
  type HarnessFeatures,
} from '@/chat/harness'
import { AgentTUIRunner, TerminalRenderer } from '@/chat/tui'
import { createIdGeneratorWithPrefix } from '@/shared/utils'
import type { SessionActor } from '@/runtime/actors/session/types'
import {
  openSessionCatalog,
  SESSION_CATALOG_PATH_ENV,
  type SessionCatalog,
} from '@/storage/session-catalog'
import { HELP_TEXT } from './help'
import { commandArguments } from '@/config/models'
import {
  createHarnessProviderRegistry,
  defaultModelRef,
  harnessAuthKeys,
  listModelsForActiveProvider,
  type HarnessUser,
  modelRefForProvider,
  type ModelRef,
  type ModelProvider,
} from '@/chat/harness/providers'
import { removeProductData, uninstallSensos } from './maintenance'
import { productStateDir, sessionCatalogPath } from '@/config/paths'
import {
  readProviderProfile,
  readFreshProviderProfile,
  updateProviderProfile,
} from '@/auth/profile'
import { runtimeStatus, stopRuntime } from '@/runtime/client'
import {
  connectRivetEngine,
  resolveRivetEngineTarget,
  type RivetEngineConnection,
  type RivetEngineTarget,
} from '@/runtime/engine-transport'
import { createRunStreamReader } from '@/runtime/durable-run-stream'
import {
  deleteLocalSessionActor,
  waitForLocalSessionDeletion,
} from '@/runtime/sessions'
import {
  deleteSessionsConfirmationMessage,
  formatLocalSessions,
  listLocalSessions,
  pickLocalSession,
  pickLocalSessions,
} from './sessions'
import { runAuthCommand } from './auth'
import { normalizeCliInvocation } from '../state'
import { recordTiming } from '@/shared/timing'

configureDefaultLogger(
  process.env.SENSOS_LOG_LEVEL === 'warn' ? 'warn' : 'silent'
)

const createClientId = createIdGeneratorWithPrefix('cli')
const createChatId = createIdGeneratorWithPrefix('chat')
const createIdempotencyId = createIdGeneratorWithPrefix('request')
const clientId = createClientId()
const authKeys = harnessAuthKeys(createHarnessProviderRegistry())
if (!authKeys[0]) {
  throw new Error(
    'No model-provider authentication methods are registered.'
  )
}

type SessionConnection = ActorConn<SessionActor>
type ChatOptions = {
  sessionId?: string
  cwd: string
  model?: string
  features: HarnessFeatures
  pickSession?: boolean
  createSession?: boolean
  engineTarget: RivetEngineTarget
}

async function chooseProvider(provider: ModelProvider): Promise<void> {
  const profile = await readProviderProfile()
  if (
    provider === 'gateway' &&
    !profile.credentials.gateway &&
    !process.env.AI_GATEWAY_API_KEY
  ) {
    throw new Error('Gateway is not connected. Run `sensos login` first.')
  }
  if (provider === 'codex' && !profile.credentials.codex) {
    throw new Error(
      'Codex is not connected. Run `sensos login codex` first.'
    )
  }
  await updateProviderProfile(current => ({
    ...current,
    activeProvider: provider,
  }))
  console.log(`Active provider: ${provider}`)
}

async function providerInfo(): Promise<void> {
  const initial = await readProviderProfile()
  const profile = await readFreshProviderProfile(initial.activeProvider)
  const providers = createHarnessProviderRegistry(profile.credentials)
  let user: HarnessUser
  switch (profile.activeProvider) {
    case 'gateway': {
      const credential = profile.credentials.gateway
      if (!credential) {
        throw new Error(
          'Gateway is not connected with Vercel. Run `sensos login vercel` first.'
        )
      }
      const loadUser = providers.gateway.auth.user
      if (!loadUser) throw new Error('Gateway user info is unavailable.')
      user = await loadUser(credential)
      break
    }
    case 'codex': {
      const credential = profile.credentials.codex
      if (!credential) {
        throw new Error(
          'Codex is not connected. Run `sensos login codex` first.'
        )
      }
      const loadUser = providers.codex.auth.user
      if (!loadUser) throw new Error('Codex user info is unavailable.')
      user = await loadUser(credential)
      break
    }
  }
  console.log(`active provider: ${profile.activeProvider}`)
  console.log(`name: ${user.name}`)
  console.log(`email: ${user.email}`)
  if (user.affiliation) {
    console.log(`${user.affiliation.kind}: ${user.affiliation.name}`)
  }
}

async function runChatSession(
  options: ChatOptions,
  catalog: SessionCatalog,
  engine: Promise<RivetEngineConnection>
): Promise<'exit' | 'switch-session'> {
  let connection: SessionConnection | undefined
  let sessionDeleted = false
  let activeSessionId: string | undefined
  let connectionReady: Promise<SessionConnection> | undefined
  let outcome: 'exit' | 'switch-session' = 'exit'
  let closing = false
  try {
    let sessionId = options.sessionId
    if (options.pickSession) {
      const sessions = await listLocalSessions(
        catalog,
        resolve(options.cwd)
      )
      if (sessions.length === 0) {
        console.log('No saved sessions.')
        return 'exit'
      }
      sessionId = await pickLocalSession(sessions)
      if (!sessionId) {
        return 'exit'
      }
    }
    if (!sessionId) throw new Error('Session id is required')

    let catalogSession = await catalog.get(sessionId)
    if (options.createSession) {
      catalogSession = await catalog.reserve({
        sessionId,
        cwd: resolve(options.cwd),
      })
    } else if (!catalogSession || catalogSession.deletedAt) {
      throw new Error(`Session ${sessionId} does not exist`)
    }
    activeSessionId = sessionId

    const localMessages = await catalog.getMessages(sessionId)
    const renderer = new TerminalRenderer({
      reasoning: 'auto-collapsed',
      tools: 'auto-collapsed',
      responseStatistics: 'outputTokensPerSecond',
    })

    const initialProvider = (await readProviderProfile()).activeProvider
    let selectedModel: ModelRef = options.model
      ? modelRefForProvider(initialProvider, options.model)
      : defaultModelRef(initialProvider)
    const ready = (async () => {
      const startedAt = Date.now()
      recordTiming('client.session.connect_start', { sessionId })
      const engineConnection = await engine
      recordTiming('client.engine.ready', {
        sessionId,
        elapsedMs: Date.now() - startedAt,
      })
      const client = engineConnection.client
      const handle = client.session.getOrCreate([sessionId], {
        createWithInput: {
          sessionId,
          catalogRevision: catalogSession.revision,
          cwd: options.cwd,
          ...(selectedModel ? { model: selectedModel } : {}),
          features: options.features,
        },
      })
      const nextConnection = handle.connect({ clientId })
      connection = nextConnection
      await nextConnection.setFeatures(options.features)
      recordTiming('client.session.connected', {
        sessionId,
        elapsedMs: Date.now() - startedAt,
      })
      const snapshot = await nextConnection.getSession()
      recordTiming('client.session.hydrated', {
        sessionId,
        elapsedMs: Date.now() - startedAt,
      })
      selectedModel = snapshot.model
      return { connection: nextConnection, snapshot }
    })()
    const readyConnection = ready.then(value => value.connection)
    connectionReady = readyConnection
    void connectionReady
      .then(value => {
        if (closing) return value.dispose()
      })
      .catch(() => undefined)

    const chatTransport = new DeferredSessionChatTransport(
      connectionReady,
      {
        readStream: async function* (streamOptions) {
          yield* createRunStreamReader((await engine).streamsEndpoint)(
            streamOptions
          )
        },
      }
    )
    outcome = await new AgentTUIRunner({
      renderer,
      title: `sensos · ${catalogSession.title ?? sessionId}`,
      chatId: sessionId,
      initialMessages: localMessages,
      hydration: ready.then(({ snapshot }) => snapshot),
      hydrationUpdates: apply => {
        let disposed = false
        let unsubscribe: (() => void) | undefined
        void readyConnection
          .then(nextConnection => {
            if (disposed) return
            const rehydrate = () => {
              void nextConnection
                .getSession()
                .then(snapshot => {
                  if (!disposed) apply(snapshot)
                })
                .catch(() => undefined)
            }
            const unsubscribeTitle = nextConnection.on(
              'titleChanged',
              rehydrate
            )
            const unsubscribeMessages = nextConnection.on(
              'messagesChanged',
              rehydrate
            )
            unsubscribe = () => {
              unsubscribeTitle()
              unsubscribeMessages()
            }
            rehydrate()
          })
          .catch(() => undefined)
        return () => {
          disposed = true
          unsubscribe?.()
        }
      },
      transport: chatTransport,
      requestOptions: () => ({
        body: {
          idempotencyId: createIdempotencyId(),
          ...(selectedModel ? { model: selectedModel } : {}),
        },
      }),
      reasoning: 'auto-collapsed',
      tools: 'auto-collapsed',
      responseStatistics: 'outputTokensPerSecond',
      commands: [
        {
          name: '/interrupt',
          argumentHint: '<message>',
          description: 'Steer the active run with a new message',
          run: argument =>
            argument
              ? { prompt: argument, priority: 'now' as const }
              : undefined,
        },
        {
          name: '/queue',
          argumentHint: '<message>',
          description: 'Queue a message for the next turn',
          run: argument =>
            argument
              ? { prompt: argument, priority: 'next' as const }
              : undefined,
        },
        {
          name: '/stop',
          description: 'Stop the active run without sending a message',
          run: async () => {
            await chatTransport.stopActiveRun()
            return undefined
          },
        },
        {
          name: '/model',
          description: 'Choose the model for subsequent messages',
          run: async () => {
            let model: ModelRef
            try {
              const models = await listModelsForActiveProvider()
              if (models.length === 0) {
                throw new Error('The active provider returned no models.')
              }
              model = await select({
                message: 'Select a model',
                choices: models.map(({ ref, name, description }) => ({
                  name,
                  value: ref,
                  ...(description ? { description } : {}),
                })),
              })
            } catch (error) {
              if (
                error instanceof Error &&
                error.name === 'ExitPromptError'
              ) {
                return 'exit'
              }
              throw error
            }
            await (await connectionReady)?.setModel(model)
            selectedModel = model
            return undefined
          },
        },
        {
          name: '/delete',
          description: 'Permanently delete this session and transcript',
          run: async () => {
            let approved: boolean
            try {
              approved = await confirm({
                message: `Permanently delete ${sessionId}?`,
                default: false,
              })
            } catch (error) {
              if (
                error instanceof Error &&
                error.name === 'ExitPromptError'
              ) {
                return undefined
              }
              throw error
            }
            if (!approved) return undefined
            const activeConnection = await connectionReady
            await catalog.tombstone(sessionId)
            await activeConnection?.deleteSession()
            await activeConnection?.dispose()
            connection = undefined
            sessionDeleted = true
            const engineEndpoint = (await engine).endpoint
            await deleteLocalSessionActor(engineEndpoint, sessionId)
            await waitForLocalSessionDeletion(engineEndpoint, sessionId)
            return 'exit'
          },
        },
        {
          name: '/switch-session',
          description: 'Switch to another session',
          run: () => 'switch-session',
        },
      ],
    }).run()
    return outcome
  } finally {
    closing = true
    if (connection) {
      await Promise.race([connection.dispose(), Bun.sleep(2_000)])
    }
    if (
      outcome !== 'switch-session' &&
      activeSessionId &&
      !sessionDeleted
    ) {
      console.log(
        `\x1b[90mResume this session with:\nsensos --resume ${activeSessionId}\x1b[0m`
      )
    }
  }
}

async function runChat(
  options: ChatOptions,
  catalog: SessionCatalog,
  root: string
): Promise<void> {
  const engine = connectRivetEngine(options.engineTarget, root)
  let nextOptions = options
  try {
    while (true) {
      const outcome = await runChatSession(nextOptions, catalog, engine)
      if (outcome !== 'switch-session') return
      nextOptions = {
        ...options,
        sessionId: undefined,
        pickSession: true,
        createSession: false,
      }
    }
  } finally {
    await (await engine).release()
  }
}

async function deleteSessions(
  catalog: SessionCatalog,
  root: string,
  cwd: string,
  target: RivetEngineTarget
): Promise<void> {
  const sessions = await listLocalSessions(catalog, resolve(cwd))
  if (sessions.length === 0) {
    console.log('No saved sessions.')
    return
  }

  let selected: typeof sessions
  try {
    selected = await pickLocalSessions(sessions)
  } catch (error) {
    if (error instanceof Error && error.name === 'ExitPromptError') return
    throw error
  }
  if (selected.length === 0) return

  let approved: boolean
  try {
    approved = await confirm({
      message: deleteSessionsConfirmationMessage(selected),
      default: false,
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'ExitPromptError') return
    throw error
  }
  if (!approved) return

  await Promise.all(
    selected.map(session => catalog.tombstone(session.sessionId))
  )
  const engine = await connectRivetEngine(target, root)
  try {
    for (const session of selected) {
      await deleteLocalSessionActor(engine.endpoint, session.sessionId)
      await waitForLocalSessionDeletion(engine.endpoint, session.sessionId)
    }
  } finally {
    await engine.release()
  }
  console.log(
    `Deleted ${selected.length} ${selected.length === 1 ? 'session' : 'sessions'}.`
  )
}

async function nukeSessions(
  catalog: SessionCatalog,
  root: string,
  target: RivetEngineTarget
): Promise<void> {
  const sessions = await listLocalSessions(catalog)
  if (sessions.length === 0) {
    console.log('No saved sessions.')
    return
  }

  const engine = await connectRivetEngine(target, root)
  try {
    await Promise.all(
      sessions.map(async session => {
        await deleteLocalSessionActor(engine.endpoint, session.sessionId)
        await waitForLocalSessionDeletion(
          engine.endpoint,
          session.sessionId
        )
      })
    )
    await catalog.purge(sessions.map(session => session.sessionId))
  } finally {
    await engine.release()
  }
  console.log(`Deleted ${sessions.length} sessions.`)
}

function readOptions(args: string[], sessionId?: string): ChatOptions {
  const valueFor = (flag: string) => {
    const index = args.indexOf(flag)
    return index >= 0 ? args[index + 1] : undefined
  }
  return {
    sessionId: sessionId ?? createChatId(),
    createSession: !sessionId,
    cwd: valueFor('--cwd') ?? process.cwd(),
    model: valueFor('--model'),
    features: resolveHarnessFeatures({
      ...(args.includes('--test-model') ? { useMockModel: true } : {}),
    }),
    engineTarget: resolveRivetEngineTarget({
      localEngine: args.includes('--local-engine'),
    }),
  }
}

async function latestSessionId(
  catalog: SessionCatalog,
  cwd: string
): Promise<string | undefined> {
  return (await listLocalSessions(catalog, resolve(cwd)))[0]?.sessionId
}

async function main(): Promise<void> {
  const invocation = normalizeCliInvocation(process.argv.slice(2), {
    stdinIsTTY:
      process.env.SENSOS_CLI_INTERACTIVE === undefined
        ? process.stdin.isTTY
        : process.env.SENSOS_CLI_INTERACTIVE === '1',
    stdoutIsTTY:
      process.env.SENSOS_CLI_INTERACTIVE === undefined
        ? process.stdout.isTTY
        : process.env.SENSOS_CLI_INTERACTIVE === '1',
  })
  const rawArgs = invocation.argv
  const normalized = commandArguments(rawArgs)
  const [command, ...args] = normalized
  if (command === 'help') {
    console.log(HELP_TEXT)
    return
  }
  if (
    (command === 'login' || command === 'logout' || command === 'auth') &&
    (await runAuthCommand(command, args, invocation.state))
  ) {
    return
  }
  if (command === 'provider') {
    const provider = args[0]
    if (provider === 'info') {
      await providerInfo()
      return
    }
    if (provider !== 'gateway' && provider !== 'codex') {
      throw new Error('Usage: sensos provider <gateway|codex>')
    }
    await chooseProvider(provider)
    return
  }

  const root = productStateDir()
  const catalogPath = sessionCatalogPath(root)
  process.env[SESSION_CATALOG_PATH_ENV] = catalogPath
  if (command === 'runtime' && args[0] === 'status') {
    const status = await runtimeStatus(root)
    console.log(
      status.ready
        ? `Runtime ready (pid ${status.pid}, ${status.leases ?? 0} leases, protocol ${status.protocolVersion ?? 'unknown'}, build ${status.buildId?.slice(0, 12) ?? 'unknown'})`
        : 'Runtime stopped'
    )
    return
  }
  if (command === 'runtime' && args[0] === 'stop') {
    console.log(
      (await stopRuntime(root))
        ? 'Runtime stopped.'
        : 'Runtime was not running.'
    )
    return
  }
  const catalog = openSessionCatalog(catalogPath)
  if (command === 'reset' || command === 'uninstall') {
    try {
      await nukeSessions(
        catalog,
        root,
        resolveRivetEngineTarget({
          localEngine: args.includes('--local-engine'),
        })
      )
    } finally {
      catalog.close()
    }
    await removeProductData(root)
    if (command === 'uninstall') {
      await uninstallSensos()
      console.log('Successfully uninstalled.')
    } else {
      console.log('Sensos reset complete.')
    }
    return
  }
  if (
    command === 'sessions' &&
    (args.length === 0 || args[0] === 'list')
  ) {
    const sessions = await listLocalSessions(
      catalog,
      resolve(process.cwd())
    )
    console.log(
      sessions.length === 0
        ? 'No saved sessions for this workspace.'
        : formatLocalSessions(sessions)
    )
    return
  }
  if (command === 'picker') {
    const options = readOptions(args)
    await runChat(
      {
        ...options,
        sessionId: undefined,
        createSession: false,
        pickSession: true,
      },
      catalog,
      root
    )
    return
  }
  if (command === 'sessions' && args[0] === 'delete') {
    await deleteSessions(
      catalog,
      root,
      process.cwd(),
      resolveRivetEngineTarget({
        localEngine: args.includes('--local-engine'),
      })
    )
    return
  }
  if (command === 'sessions' && args[0] === 'nuke') {
    await nukeSessions(
      catalog,
      root,
      resolveRivetEngineTarget({
        localEngine: args.includes('--local-engine'),
      })
    )
    return
  }
  if (command === 'resume' || command === 'session') {
    const requested = args[0]
    if (!requested) {
      console.error(HELP_TEXT)
      process.exitCode = 1
      return
    }
    const optionArgs = args.slice(1)
    const cwdIndex = optionArgs.indexOf('--cwd')
    const cwd =
      (cwdIndex >= 0 ? optionArgs[cwdIndex + 1] : undefined) ??
      process.cwd()
    const sessionId =
      requested === 'last'
        ? await latestSessionId(catalog, cwd)
        : requested
    if (!sessionId) {
      console.log('No saved sessions for this workspace.')
      return
    }
    await runChat(readOptions(optionArgs, sessionId), catalog, root)
    return
  }
  if (command !== 'new') {
    console.error(HELP_TEXT)
    process.exitCode = 1
    return
  }
  await runChat(readOptions(args), catalog, root)
}

try {
  await main()
  process.exit(process.exitCode ?? 0)
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}
