import { confirm, select } from '@inquirer/prompts'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { createClient, type ActorConn } from 'rivetkit/client'
import { configureDefaultLogger } from 'rivetkit/log'
import { DeferredSessionChatTransport } from '@/chat/transport'
import {
  resolveHarnessFeatures,
  type HarnessFeatures,
} from '@/chat/harness'
import { AgentTUIRunner, TerminalRenderer } from '@/chat/tui'
import { createIdGeneratorWithPrefix } from '@/shared/utils'
import type { SessionActor } from '@/runtime/actors/session/types'
import type { registry } from '@/runtime/actors/registry'
import {
  openSessionCatalog,
  SESSION_CATALOG_PATH_ENV,
  type SessionCatalog,
} from '@/storage/session-catalog'
import { HELP_TEXT } from './help'
import { CHAT_MODELS, commandArguments } from '@/config/models'
import { removeProductData, uninstallSensos } from './maintenance'
import { productStateDir, sessionCatalogPath } from '@/config/paths'
import {
  clearProviderCredential,
  readProviderProfile,
  updateProviderProfile,
  type ModelProvider,
} from '@/auth/profile'
import { loginWithCodex } from '@/auth/oauth/codex'
import {
  beginVercelLogin,
  completeVercelLogin,
  listVercelTeams,
} from '@/auth/oauth/vercel'
import {
  acquireRuntime,
  RUNTIME_ENDPOINT,
  runRuntimeSupervisor,
  runtimeStatus,
  stopRuntime,
  type RuntimeLease,
} from '@/runtime'
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

configureDefaultLogger(
  process.env.SENSOS_LOG_LEVEL === 'warn' ? 'warn' : 'silent'
)

const createClientId = createIdGeneratorWithPrefix('cli')
const createChatId = createIdGeneratorWithPrefix('chat')
const createIdempotencyId = createIdGeneratorWithPrefix('request')
const clientId = createClientId()

type SessionConnection = ActorConn<SessionActor>
type ChatOptions = {
  sessionId?: string
  cwd: string
  model?: string
  features: HarnessFeatures
  pickSession?: boolean
  createSession?: boolean
}

function openBrowser(url: string): Promise<void> {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]]
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

async function login(provider: 'vercel' | 'codex'): Promise<void> {
  const controller = new AbortController()
  const cancel = () => controller.abort()
  process.once('SIGINT', cancel)
  try {
    if (provider === 'codex') {
      console.log('Opening OpenAI Codex sign-in in your browser.')
      const credential = await loginWithCodex(
        openBrowser,
        controller.signal
      )
      await updateProviderProfile(profile => ({
        ...profile,
        activeProvider: 'codex',
        codex: credential,
      }))
      console.log('Connected to OpenAI Codex.')
      return
    }

    const device = await beginVercelLogin(controller.signal)
    console.log(
      `Open this URL and enter code ${device.user_code}:\n${device.verification_uri_complete}`
    )
    try {
      await openBrowser(device.verification_uri_complete)
    } catch {
      console.error('Could not open a browser. Use the URL above.')
    }
    const credential = await completeVercelLogin(device, controller.signal)
    const teams = await listVercelTeams(
      credential.accessToken,
      controller.signal
    )
    if (teams.length === 0) {
      throw new Error(
        'No Vercel teams are available. Sensos requires a team-scoped AI Gateway account.'
      )
    }
    const teamId = await select({
      message: 'Choose the Vercel scope for AI Gateway',
      choices: teams.map(team => ({ name: team.name, value: team.id })),
    })
    await updateProviderProfile(profile => ({
      ...profile,
      activeProvider: 'gateway',
      vercel: { ...credential, teamId },
    }))
    console.log('Connected to Vercel AI Gateway.')
  } finally {
    process.removeListener('SIGINT', cancel)
  }
}

async function chooseProvider(provider: ModelProvider): Promise<void> {
  const profile = await readProviderProfile()
  if (
    provider === 'gateway' &&
    !profile.vercel &&
    !process.env.AI_GATEWAY_API_KEY
  ) {
    throw new Error('Gateway is not connected. Run `sensos login` first.')
  }
  if (provider === 'codex' && !profile.codex) {
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

async function runChat(
  options: ChatOptions,
  catalog: SessionCatalog,
  root: string
): Promise<void> {
  let runtime: RuntimeLease | undefined
  let connection: SessionConnection | undefined
  let chatExited = false
  let sessionDeleted = false
  let activeSessionId: string | undefined
  let connectionReady: Promise<SessionConnection> | undefined
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
        return
      }
      runtime = acquireRuntime(root)
      sessionId = await pickLocalSession(sessions)
      if (!sessionId) {
        return
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

    runtime ??= acquireRuntime(root)
    let selectedModel = options.model
    const ready = (async () => {
      await runtime?.ready
      const client = createClient<typeof registry>(RUNTIME_ENDPOINT)
      const handle = client.session.getOrCreate([sessionId], {
        createWithInput: {
          sessionId,
          catalogRevision: catalogSession.revision,
          cwd: options.cwd,
          ...(options.model ? { model: options.model } : {}),
          features: options.features,
        },
      })
      const nextConnection = handle.connect({ clientId })
      connection = nextConnection
      await nextConnection.setFeatures(options.features)
      const snapshot = await nextConnection.getSession()
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

    const chatTransport = new DeferredSessionChatTransport(connectionReady)
    await new AgentTUIRunner({
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
          description: 'Steer the active run now: /interrupt <message>',
          run: argument =>
            argument
              ? { prompt: argument, priority: 'now' as const }
              : undefined,
        },
        {
          name: '/queue',
          description: 'Queue the next turn: /queue <message>',
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
            let model: (typeof CHAT_MODELS)[number]['value']
            try {
              model = await select({
                message: 'Select a model',
                choices: CHAT_MODELS,
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
            await deleteLocalSessionActor(RUNTIME_ENDPOINT, sessionId)
            await waitForLocalSessionDeletion(RUNTIME_ENDPOINT, sessionId)
            return 'exit'
          },
        },
        {
          name: '/exit',
          description: 'Close this chat',
          run: () => 'exit',
        },
      ],
    }).run()
    chatExited = true
  } finally {
    closing = true
    if (connection) {
      await Promise.race([connection.dispose(), Bun.sleep(2_000)])
    }
    await runtime?.release()
    if (chatExited && activeSessionId && !sessionDeleted) {
      console.log(
        `\x1b[90mResume this session with:\nsensos --resume ${activeSessionId}\x1b[0m`
      )
    }
  }
}

async function deleteSessions(
  catalog: SessionCatalog,
  root: string,
  cwd: string
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
  const runtime = acquireRuntime(root)
  try {
    await runtime.ready
    for (const session of selected) {
      await deleteLocalSessionActor(RUNTIME_ENDPOINT, session.sessionId)
      await waitForLocalSessionDeletion(
        RUNTIME_ENDPOINT,
        session.sessionId
      )
    }
  } finally {
    await runtime.release()
  }
  console.log(
    `Deleted ${selected.length} ${selected.length === 1 ? 'session' : 'sessions'}.`
  )
}

async function nukeSessions(
  catalog: SessionCatalog,
  root: string
): Promise<void> {
  const sessions = await listLocalSessions(catalog)
  if (sessions.length === 0) {
    console.log('No saved sessions.')
    return
  }

  const runtime = acquireRuntime(root)
  try {
    await runtime.ready
    await Promise.all(
      sessions.map(async session => {
        await deleteLocalSessionActor(RUNTIME_ENDPOINT, session.sessionId)
        await waitForLocalSessionDeletion(
          RUNTIME_ENDPOINT,
          session.sessionId
        )
      })
    )
    await catalog.purge(sessions.map(session => session.sessionId))
  } finally {
    await runtime.release()
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
  }
}

async function latestSessionId(
  catalog: SessionCatalog,
  cwd: string
): Promise<string | undefined> {
  return (await listLocalSessions(catalog, resolve(cwd)))[0]?.sessionId
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2)
  if (rawArgs[0] === '__runtime-supervisor') {
    const rootIndex = rawArgs.indexOf('--root')
    const root = rootIndex >= 0 ? rawArgs[rootIndex + 1] : undefined
    if (!root) throw new Error('Runtime supervisor requires --root')
    await runRuntimeSupervisor(root)
    return
  }

  const normalized = commandArguments(rawArgs)
  const [command, ...args] = normalized
  if (command === 'help') {
    console.log(HELP_TEXT)
    return
  }

  if (command === 'login') {
    const provider = args[0] ?? 'vercel'
    if (provider !== 'vercel' && provider !== 'codex') {
      throw new Error('Usage: sensos login [vercel|codex]')
    }
    await login(provider)
    return
  }
  if (command === 'logout') {
    const provider = args[0] ?? 'vercel'
    if (provider !== 'vercel' && provider !== 'codex') {
      throw new Error('Usage: sensos logout [vercel|codex]')
    }
    await clearProviderCredential(provider)
    console.log(`Signed out of ${provider}.`)
    return
  }
  if (command === 'provider') {
    const provider = args[0]
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
      await nukeSessions(catalog, root)
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
    await deleteSessions(catalog, root, process.cwd())
    return
  }
  if (command === 'sessions' && args[0] === 'nuke') {
    await nukeSessions(catalog, root)
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
