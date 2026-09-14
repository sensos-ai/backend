import type {
  ActorDefinition,
  CreateVarsContextOf,
  CreateContextOf,
  CreateConnStateContextOf,
  SleepContextOf,
  DestroyContextOf,
  WakeContextOf,
  ConnectContextOf,
  Conn,
  ActionContext,
} from 'rivetkit'
import type { WorkflowContextOf } from 'rivetkit/workflow'
import type { AgentOs } from '@rivet-dev/agentos'
import type { UIMessage } from 'ai'
import { z } from 'zod'
import {
  harnessFeaturesSchema,
  type HarnessFeatures,
} from '@/chat/harness'
import type { SessionQueues, SessionEvents } from './config'
import type { InboxMessage } from './config'
import type { SessionDatabaseProvider } from './db'
import type { createRunSteeringInput } from '@/chat/harness'
import type { SteeringMessage } from '@/chat/harness'
import {
  modelRefSchema,
  type ModelRef,
} from '@/chat/harness/providers/model'

export const sessionInputSchema = z.object({
  sessionId: z.string().min(1).optional(),
  catalogRevision: z.number().int().nonnegative().optional(),
  cwd: z.string().min(1),
  model: modelRefSchema.optional(),
  instructions: z.string().optional(),
  initialMessages: z.array(z.custom<UIMessage>()).optional(),
  features: harnessFeaturesSchema.partial().optional(),
})

export type SessionInput = z.input<typeof sessionInputSchema>

export type SessionConfig = {
  hostCwd: string
  guestCwd: string
  model?: ModelRef
  instructions?: string
  features: HarnessFeatures
}

export type State = {
  sessionId: string
  catalogRevision: number
  config: SessionConfig
  initialMessages: UIMessage[]
  title?: string
}

export type ConnectionParams = {
  clientId: string
  authToken?: string
}

export type ConnectionState = {
  clientId: string
  userId?: string
}

export type Vars = {
  vm: AgentOs
  activeRun?: {
    runId: string
    abortController: AbortController
    steering: ReturnType<typeof createRunSteeringInput>
    interrupt: (message: SteeringMessage) => boolean
  }
}

export type SessionActionContext = ActionContext<
  State,
  ConnectionParams,
  ConnectionState,
  Vars,
  SessionInput,
  SessionDatabaseProvider,
  SessionEvents,
  SessionQueues
>

export type SessionAction<Args extends any[] = any[]> = (
  c: SessionActionContext,
  ...args: Args
) => any

export type SessionActions = {
  cancel: SessionAction<[runId: string]>
  deliver: SessionAction<[message: InboxMessage]>
  deleteSession: SessionAction
  getSession: SessionAction
  setModel: SessionAction<[model: ModelRef]>
  setFeatures: SessionAction<[features: HarnessFeatures]>
  getRun: SessionAction<[runId: string]>
  streamSnapshot: SessionAction<[runId: string, afterSeq?: number]>
}

export type SessionActor = ActorDefinition<
  State,
  ConnectionParams,
  ConnectionState,
  Vars,
  SessionInput,
  SessionDatabaseProvider,
  SessionEvents,
  SessionQueues,
  SessionActions
>

export type CreateVars = (
  ctx: CreateVarsContextOf<SessionActor>
) => Vars | Promise<Vars>

export type CreateState = (
  ctx: CreateContextOf<SessionActor>,
  input: SessionInput
) => State | Promise<State>

export type CreateConnState = (
  ctx: CreateConnStateContextOf<SessionActor>,
  params: ConnectionParams
) => ConnectionParams | Promise<ConnectionParams>

export type OnCreate = (
  ctx: CreateContextOf<SessionActor>,
  input: SessionInput
) => void | Promise<void>

export type OnSleep = (
  ctx: SleepContextOf<SessionActor>
) => void | Promise<void>

export type OnDestroy = (
  ctx: DestroyContextOf<SessionActor>
) => void | Promise<void>

export type OnWake = (
  ctx: WakeContextOf<SessionActor>
) => void | Promise<void>

export type OnConnect = (
  ctx: ConnectContextOf<SessionActor>,
  conn: Conn<
    State,
    ConnectionParams,
    ConnectionState,
    Vars,
    SessionInput,
    SessionDatabaseProvider,
    SessionEvents,
    SessionQueues
  >
) => void | Promise<void>

export type RunWorkflow = (
  ctx: WorkflowContextOf<SessionActor>
) => Promise<void>
