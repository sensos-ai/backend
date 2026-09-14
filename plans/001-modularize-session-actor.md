# Plan 001: Give session actors a predictable modular layout

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the STOP conditions occurs, stop and report; do
> not improvise. When done, update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat a7a4f4a..HEAD -- src/runtime/actors/session tests/rivet/session`
> This plan intentionally treats the uncommitted working-tree versions of
> `actions.ts`, `workflow.ts`, `queue.test.ts`, and `stream-control.test.ts` as
> the behavioral baseline. Do not discard or overwrite those changes. If the
> current working tree differs materially from the excerpts below, stop and
> reconcile the plan with the live code.

## Status

- **Priority**: P1
- **Effort**: L (multi-day)
- **Risk**: MED — structure-only intent, but durable workflow and transaction
  boundaries are sensitive to accidental semantic changes
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: commit `a7a4f4a`, 2026-09-14, plus the explicitly preserved
  working-tree changes described above

## Why this matters

`src/runtime/actors/session/workflow.ts` is currently 775 lines and combines
queue arbitration, inbox routing, durable submission, title generation,
stream consumption, cancellation and interruption, run finalization,
transcript projection, and event publication. `db/queries.ts` is 483 lines and
contains message, metadata, run, frame, and deletion operations. These files
make unrelated behavior difficult to locate and force most workflow testing
through a costly RivetKit integration harness.

After this plan, every `runtime/actors/<actor>` can follow the same recognizable
layout, the workflow entry point will read as the state machine, and pure
decisions can be tested without starting RivetKit.

## Target structure

```text
src/runtime/actors/
├── registry.ts
└── session/
    ├── actions/
    │   ├── index.ts
    │   ├── deliver.ts
    │   ├── runs.ts
    │   └── session.ts
    ├── config.ts
    ├── lifecycle.ts
    ├── types.ts
    ├── workflow/
    │   ├── index.ts
    │   ├── types.ts
    │   └── steps/
    │       ├── index.ts
    │       ├── process-inbox.ts
    │       ├── submit-run.ts
    │       └── execute-run.ts
    ├── db/
    │   ├── index.ts
    │   ├── database.ts
    │   ├── schema.ts
    │   ├── queries.ts
    │   ├── messages.ts
    │   ├── runs.ts
    │   ├── run-frames.ts
    │   ├── session-meta.ts
    │   └── maintenance.ts
    ├── utils/
    │   ├── messages.ts
    │   └── usage.ts
    ├── queue/
    ├── title.ts
    └── index.ts
```

The layout rules are:

- `index.ts` assembles the actor and contains no behavior.
- `actions/` contains externally callable actor actions, grouped by domain.
- `config.ts` owns queue/event schemas and their inferred types.
- `lifecycle.ts` owns actor lifecycle callbacks.
- `types.ts` owns actor state, vars, contexts, and public actor types.
- `workflow/index.ts` contains only high-level loop/race orchestration.
- `workflow/steps/` contains operations invoked by the orchestrator.
- `db/` owns persistence and transaction boundaries.
- `utils/` contains only pure, stateless helpers. A function that accesses a
  database, actor context, queue, logger, catalog, or broadcaster is not a
  utility.
- Export workflow steps only when `workflow/index.ts` invokes them. Keep
  single-consumer implementation helpers private to their owning step.

## Current state

- `src/runtime/actors/session/index.ts` already acts as a small composition
  root and imports default `actions` and `workflow` implementations.
- `src/runtime/actors/session/workflow.ts:94-178` implements inbox routing in
  the same file as execution.
- `src/runtime/actors/session/workflow.ts:277-375` owns durable run submission.
- `src/runtime/actors/session/workflow.ts:377-775` owns the outer state machine
  and the complete `execute-run` implementation.
- `src/runtime/actors/session/actions.ts:17-28` duplicates approval-waiting
  detection from `workflow.ts:83-92`.
- `src/runtime/actors/session/db/queries.ts` exports 17 operations spanning five
  persistence concerns. `db/index.ts` is already the intended public barrel.
- `tests/rivet/session/queue.test.ts` characterizes priority routing,
  interruption, successor runs, and assistant cutoff persistence.
- `tests/rivet/session/stream-control.test.ts` is an uncommitted behavioral
  baseline for disconnect-resume and explicit-stop cutoff persistence.

The current durable identifiers must remain unchanged:

```ts
context.loop('runs', ...)
loop.race('next-work', ...)
context.step('route-inbox', ...)
context.step('submit-run', ...)
branch.step({ name: 'execute-run', timeout: 0, maxRetries: 0, ... })
```

Module names describe code ownership; Rivet identifiers are persistence and
replay identities. `process-inbox.ts` must therefore retain the existing
`route-inbox` step name during this refactor.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Format | `bun run format` | exit 0; Biome formats changed files |
| Lint | `bun run lint` | exit 0; no remaining Biome diagnostics |
| Typecheck | `bun run typecheck` | exit 0; no TypeScript errors |
| Tests | `bun run test` | exit 0; all tests pass |
| Build | `bun run build` | exit 0; CLI build succeeds |

Use the repository's Biome scripts. Do not introduce or run Prettier.

## Scope

**In scope**:

- `src/runtime/actors/session/actions.ts` may be replaced by `actions/`.
- `src/runtime/actors/session/workflow.ts` may be replaced by `workflow/`.
- `src/runtime/actors/session/db/queries.ts` and `db/index.ts` may be converted
  into compatibility barrels over focused database modules.
- `src/runtime/actors/session/utils/` may be added for shared pure helpers.
- Tests below `tests/rivet/session/` may be added or reorganized.
- `src/runtime/actors/session/index.ts` may receive import-only adjustments.

**Out of scope**:

- Actor action names or signatures.
- Queue names, event names, event payloads, statuses, and run completion shape.
- Database schema, migrations, or stored payload formats.
- Durable workflow loop, race, branch, and step identifiers.
- Session catalog semantics, title-generation behavior, provider configuration,
  or model behavior.
- Transport, TUI, and CLI behavior. Their current uncommitted changes belong to
  the user and must not be edited as part of this plan.
- Generalizing an actor framework before a second actor needs it.

## Git workflow

- Create a branch using the repository's conventional type prefix, for example
  `refactor/modular-session-actor`.
- Preserve all pre-existing working-tree changes. Do not reset or restore them.
- Commit by logical phase: characterization tests, pure helpers, workflow
  split, database split, then action layout if independently reviewable.
- Use conventional commit messages matching repository history, for example
  `refactor: modularize session actor workflow`.
- Do not push or open a PR unless instructed by the operator.

## Step 1: Characterize the live behavior

Keep the existing `queue.test.ts` and `stream-control.test.ts` scenarios. Split
or add tests only where doing so makes each invariant independently readable.
Before moving production code, ensure coverage for:

- `now` interrupts the active run and starts a successor run.
- `adaptive` steers the active run and persists its message immediately.
- `next` remains queued until the active run terminates.
- refused active steering falls back to a queued run, matching the live code.
- duplicate submission remains idempotent.
- cancellation before execution and during streaming.
- disconnect does not cancel an active run; replay resumes from durable frames.
- interrupted/stopped output persists the current assistant message or the
  existing `[Interrupted]` / `[Stopped]` cutoff fallback.
- durable finalization precedes terminal-frame publication, transcript update,
  and terminal-status publication.

Do not rewrite integration tests into implementation-detail tests. They are the
guardrail for subsequent moves.

**Verify**: `bun run typecheck && bun run test` → exit 0 and all tests pass.

## Step 2: Extract shared pure decisions

Create `src/runtime/actors/session/utils/messages.ts` for pure message
operations shared by actions and workflow:

```ts
export function messageWithOrigin(
  inboxMessage: InboxMessage
): UIMessage {
  const metadata =
    inboxMessage.message.metadata &&
    typeof inboxMessage.message.metadata === 'object'
      ? inboxMessage.message.metadata
      : {}

  return {
    ...inboxMessage.message,
    metadata: {
      ...metadata,
      sensosOrigin: inboxMessage.origin,
    },
  }
}

export function isWaitingForHumanInput(
  messages: UIMessage[]
): boolean {
  const latest = messages.at(-1)
  return (
    latest?.role === 'assistant' &&
    latest.parts.some(
      part =>
        isToolUIPart(part) &&
        part.state === 'approval-requested' &&
        part.approval.isAutomatic !== true
    )
  )
}

export function hasAssistantContent(
  message: UIMessage | undefined
): boolean {
  return message?.parts.some(part => part.type !== 'step-start') ?? false
}
```

Create `utils/usage.ts` for `addCount` and `aggregateUsage`. Export only helpers
with multiple consumers or direct unit-test value; otherwise keep helpers local
to their owner.

Move inbox routing policy into a pure function colocated with
`workflow/steps/process-inbox.ts`:

```ts
export type InboxRouteDecision =
  | { kind: 'queue' }
  | { kind: 'steer'; mode: 'interrupt' | 'adaptive' }
  | { kind: 'refuse'; reason: 'waiting_for_input' }

export function decideInboxRoute(input: {
  priority: InboxMessage['priority']
  hasActiveRun: boolean
  waitingForHumanInput: boolean
}): InboxRouteDecision {
  if (input.priority === 'now' && input.hasActiveRun) {
    return { kind: 'steer', mode: 'interrupt' }
  }
  if (input.priority === 'adaptive' && input.hasActiveRun) {
    return { kind: 'steer', mode: 'adaptive' }
  }
  if (input.priority === 'now' && input.waitingForHumanInput) {
    return { kind: 'refuse', reason: 'waiting_for_input' }
  }
  return { kind: 'queue' }
}
```

The effectful `processInbox` applies the decision. Keep actor access in this
thin imperative shell and keep the policy function above free of RivetKit:

```ts
export async function processInbox(
  context: SessionWorkflowContext
): Promise<{ kind: 'inbox' }> {
  const queued = await context.queue.next('next-inbox', {
    names: ['inbox'],
  })
  const inboxMessage = queued.body

  await context.step('route-inbox', async step => {
    if (await messageExists(step.db, inboxMessage.message.id)) return

    const activeRun = step.vars.activeRun
    const waitingForHumanInput =
      inboxMessage.priority === 'now' && !activeRun
        ? isWaitingForHumanInput(await listMessages(step.db))
        : false
    const decision = decideInboxRoute({
      priority: inboxMessage.priority,
      hasActiveRun: activeRun !== undefined,
      waitingForHumanInput,
    })

    if (decision.kind === 'refuse') {
      step.broadcast('deliveryRouted', {
        id: inboxMessage.id,
        status: 'refused',
        reason: decision.reason,
        origin: inboxMessage.origin,
      })
      return
    }

    if (decision.kind === 'steer' && activeRun) {
      const message = messageWithOrigin(inboxMessage)
      const steeringMessage = {
        message,
        origin: inboxMessage.origin,
      }
      const accepted =
        decision.mode === 'interrupt'
          ? activeRun.interrupt(steeringMessage)
          : activeRun.steering.push(steeringMessage)

      // Preserve the live fallback: a rejected steer becomes queued work.
      if (!accepted) {
        await queueRun(step, inboxMessage)
        publishQueued(step, inboxMessage)
        return
      }

      if (decision.mode === 'adaptive') {
        const appended = await appendMessageIfAbsent(
          step.db,
          message,
          new Date(inboxMessage.createdAt)
        )
        await publishTranscript(step, appended.revision)
      }

      step.broadcast('deliveryRouted', {
        id: inboxMessage.id,
        status: 'steered',
        runId: activeRun.runId,
        origin: inboxMessage.origin,
      })
      return
    }

    await queueRun(step, inboxMessage)
    publishQueued(step, inboxMessage)
  })

  return { kind: 'inbox' }
}

async function queueRun(
  context: ProcessInboxStepContext,
  inboxMessage: InboxMessage
): Promise<void> {
  await context.queue.send('runs', {
    idempotencyId: inboxMessage.id,
    model: context.state.config.model,
    message: messageWithOrigin(inboxMessage),
  })
}
```

`publishQueued` and `publishTranscript` may remain private in this module if
they have no second consumer. If transcript projection is also used by actions
or execution, move only that shared effect into a specifically named session
module; do not hide it in `utils/`.

Add fast unit tests under `tests/rivet/session/utils/` and
`tests/rivet/session/workflow/process-inbox.test.ts`. These tests must not call
`setup`, `setupTest`, or start RivetKit.

**Verify**: `bun test tests/rivet/session/utils tests/rivet/session/workflow`
→ exit 0; all pure tests pass without starting a Rivet engine.

## Step 3: Establish the workflow directory and types

Replace `workflow.ts` with `workflow/index.ts`, relying on normal directory
index resolution so `session/index.ts` may continue importing `./workflow`.
Create `workflow/types.ts` for workflow-only types such as:

```ts
export type SessionWorkflowContext = Parameters<RunWorkflow>[0]
export type QueuedRun = QueueResult<SessionQueues, 'runs'>

export type AcceptedWork = {
  command: RunCommand
  submission: RunCompletion
}

export type NextWork =
  | (AcceptedWork & { kind: 'run' })
  | { kind: 'inbox' }

export type ExecuteRunInput = {
  command: RunCommand
  runId: string
}

export type ConsumedRunStream = {
  responseMessage?: UIMessage
  outcome: UIMessageStreamOutcome
  finishReason?: FinishReason
  steps: RunStepMetadata[]
  totalUsage: LanguageModelUsage
  nextSequence: number
}

export type TerminalRunOutcome = {
  status: Extract<
    RunStatus,
    'cancelled' | 'completed' | 'failed' | 'interrupted'
  >
  chunk: UIMessageChunk
  error?: string
  finishReason?: FinishReason
}
```

Do not place database row types, actor state, action signatures, or generic
helpers in this file.

Create `workflow/steps/index.ts` with only orchestrator-facing exports:

```ts
export { executeRun } from './execute-run'
export { processInbox } from './process-inbox'
export { submitRun } from './submit-run'
```

There must be no exported `consumeRunStream` symbol.

**Verify**: `bun run typecheck` → exit 0 with no context casts added to make the
split compile.

## Step 4: Extract `process-inbox` and `submit-run`

Move `routeInboxMessage` into `workflow/steps/process-inbox.ts`, rename the
TypeScript function to `processInbox`, and retain the durable step identifier
`route-inbox`.

Move `acceptQueuedRun` into `workflow/steps/submit-run.ts`, rename the exported
operation to `submitRun`, and retain the durable step identifier `submit-run`.
Keep new-run title scheduling with submission because it is triggered by a
newly created durable run. Do not merge it with lifecycle title recovery; their
state-saving behavior differs.

The exported operation should own queue receipt/completion while the durable
callback owns database mutation and event publication:

```ts
export async function submitRun(
  context: SessionWorkflowContext
): Promise<NextWork> {
  const queued = await context.queue.next('next-run', {
    names: ['runs'],
    completable: true,
  })

  const submission = await context.step('submit-run', async step => {
    const result = await submitRunToDatabase(step.db, {
      runId: createRunId(),
      idempotencyId: queued.body.idempotencyId,
      model: queued.body.model,
      message: queued.body.message,
      assistantMessageId: createMessageId(),
    })

    if (result.created) {
      scheduleRunTitle(step, queued.body.message)
      await publishCreatedRun(step, result)
    }

    publishDeliveryResult(step, queued.body, result)

    return {
      accepted: result.accepted,
      deduplicated: result.accepted && !result.created,
      runId: result.run.id,
      status: result.run.status,
      ...(!result.accepted
        ? { reason: 'session_busy' as const }
        : {}),
    } satisfies RunCompletion
  })

  await queued.complete(submission)
  return { kind: 'run', command: queued.body, submission }
}
```

Use an alias such as `submitRunToDatabase` for the imported database function
so the workflow operation can use the domain name `submitRun` without an import
collision. `scheduleRunTitle`, `publishCreatedRun`, and
`publishDeliveryResult` should remain private to this module.

Effectful functions should accept the narrowest real Rivet context type that
compiles structurally. Do not introduce `any`, `as unknown as`, or a service
class that mirrors the entire actor context.

**Verify**: `bun run typecheck && bun test tests/rivet/session/queue.test.ts`
→ exit 0 and queue semantics remain unchanged.

## Step 5: Extract `execute-run` with a private stream consumer

Move the existing `execute-run` step into
`workflow/steps/execute-run.ts`. Export `executeRun` for the orchestrator, but
keep its streaming implementation local because it has one consumer:

```ts
async function consumeRunStream(
  context: ExecuteRunContext,
  input: ConsumeRunStreamInput
): Promise<ConsumedRunStream> {
  const harness = createSessionHarness(context, input)
  const steps: RunStepMetadata[] = []
  let responseMessage: UIMessage | undefined
  const endState: {
    outcome: UIMessageStreamOutcome
    finishReason?: FinishReason
  } = { outcome: { status: 'unknown' } }

  const stream = await createAgentUIStream({
    agent: harness.agent,
    uiMessages: harness.initialMessages,
    abortSignal: input.signal,
    generateMessageId: () => input.run.assistantMessageId,
    sendFinish: false,
    onStepEnd: result => {
      steps.push(toRunStepMetadata(result))
    },
    onEnd: event => {
      responseMessage = event.responseMessage
      endState.outcome = event.outcome
      endState.finishReason = event.finishReason
    },
  })

  // Preserve a reconstructed response when AI SDK's onEnd callback does not
  // provide one for an aborted stream.
  let streamedResponseMessage: UIMessage | undefined
  let snapshotController:
    | ReadableStreamDefaultController<UIMessageChunk>
    | undefined
  const snapshots = readUIMessageStream({
    stream: new ReadableStream<UIMessageChunk>({
      start(controller) {
        snapshotController = controller
      },
    }),
  })
  const consumeSnapshots = (async () => {
    for await (const snapshot of snapshots) {
      streamedResponseMessage = snapshot
    }
  })()

  try {
    for await (const chunk of stream) {
      snapshotController?.enqueue(chunk)
      if (chunk.type !== 'abort') await input.publishFrame(chunk)
    }
  } finally {
    snapshotController?.close()
    await consumeSnapshots
  }

  return {
    responseMessage: responseMessage ?? streamedResponseMessage,
    outcome: endState.outcome,
    finishReason: endState.finishReason,
    steps,
    totalUsage: aggregateUsage(steps),
    nextSequence: input.currentSequence(),
  }
}

export async function executeRun(
  context: SessionWorkflowContext,
  input: ExecuteRunInput
): Promise<void> {
  await context.step({
    name: 'execute-run',
    timeout: 0,
    maxRetries: 0,
    run: async step => {
      const run = await getRun(step.db, input.runId)
      if (!run || terminalStatuses.has(run.status)) return

      const activeRun = createActiveRun(run.id)
      step.vars.activeRun = activeRun.publicState

      try {
        if (run.status === 'cancel_requested') {
          await finalizeCancelledBeforeExecution(step, run)
          return
        }

        await updateRun(step.db, run.id, {
          status: 'running',
          error: null,
          startedAt: run.startedAt ?? new Date(),
        })
        publishStatus(step, run.id, 'running')

        const result = await consumeRunStream(step, {
          run,
          command: input.command,
          signal: activeRun.signal,
          publishFrame: activeRun.publishFrame,
        })
        const terminal = resolveRunOutcome({
          outcome: result.outcome,
          cancelled: activeRun.cancelled,
          interrupted: activeRun.interrupted,
          workflowAborted: step.abortSignal.aborted,
        })

        await finalizeAndPublishRun(step, run, terminal, result)
      } catch (error) {
        await finalizeExecutionError(step, run, error)
      } finally {
        await requeuePendingSteering(step, input.command, activeRun)
        if (step.vars.activeRun?.runId === run.id) {
          step.vars.activeRun = undefined
        }
      }
    },
  })
}
```

The example describes ownership, not permission to replace working stream
logic wholesale. Move the live implementation incrementally, including its
`readUIMessageStream` fallback, cutoff response construction, signal joining,
frame sequencing, and `finally` cleanup.

Keep terminal-state selection pure and directly tested. A suitable shape is:

```ts
export function resolveRunOutcome(input: {
  outcome: UIMessageStreamOutcome
  cancelled: boolean
  interrupted: boolean
  workflowAborted: boolean
}): TerminalRunOutcome {
  if (input.cancelled) return cancelledOutcome()
  if (
    input.interrupted ||
    input.workflowAborted ||
    input.outcome.status === 'aborted'
  ) {
    return interruptedOutcome()
  }
  if (input.outcome.status === 'completed') {
    return completedOutcome(input.outcome)
  }
  return failedOutcome(input.outcome)
}
```

Keep persistence/event ordering visible in one local helper. It must preserve
the current rule that the transaction lands before terminal events are sent:

```ts
async function finalizeAndPublishRun(
  context: ExecuteRunStepContext,
  run: RunRow,
  terminal: TerminalRunOutcome,
  streamed: ConsumedRunStream
): Promise<void> {
  const responseMessage = shouldPersistAssistantMessage(
    terminal.status,
    streamed.responseMessage
  )
    ? cutoffAssistantMessage(
        run.assistantMessageId,
        streamed.responseMessage,
        terminal.status === 'cancelled'
          ? '[Stopped]'
          : '[Interrupted]'
      )
    : undefined

  const finalized = await finalizeRun(context.db, run.id, {
    status: terminal.status,
    sequence: streamed.nextSequence,
    chunk: terminal.chunk,
    responseMessage,
    error: terminal.error,
    finishReason: terminal.finishReason,
    steps: streamed.steps,
    totalUsage: streamed.totalUsage,
    responseMetadata: streamed.steps.at(-1)?.response,
  })

  context.broadcast('frame', {
    runId: run.id,
    seq: streamed.nextSequence,
    chunk: terminal.chunk,
  })
  await publishTranscript(context, finalized.revision)
  publishStatus(context, run.id, terminal.status, terminal.error)
}
```

Keep `createActiveRun`, `finalizeCancelledBeforeExecution`,
`finalizeExecutionError`, `finalizeAndPublishRun`, `publishStatus`, and
`requeuePendingSteering` private inside `execute-run.ts` until another workflow
step needs one of them. Only pure decisions should be exported for direct unit
tests.

Do not create a nested Rivet `consume-run-stream` step. Stream controllers,
abort signals, steering state, and response accumulation remain inside the
existing `execute-run` durability boundary.

**Verify**:
`bun run typecheck && bun test tests/rivet/session/queue.test.ts tests/rivet/session/stream-control.test.ts`
→ exit 0; interruption, stop, disconnect, replay, and cutoff scenarios pass.

## Step 6: Reduce `workflow/index.ts` to orchestration

The completed entry point should approximately follow this shape:

```ts
export const runWorkflow: RunWorkflow = async context => {
  await context.loop('runs', async loop => {
    const received = await loop.race('next-work', [
      {
        name: 'run',
        run: branch => submitRun(branch),
      },
      {
        name: 'inbox',
        run: branch => processInbox(branch),
      },
    ])

    if (received.value.kind === 'inbox') return
    const { command, submission } = received.value
    if (!submission.accepted || submission.deduplicated) return

    await loop.race(`execute-run-${submission.runId}`, [
      {
        name: 'execute',
        run: branch =>
          executeRun(branch, { command, runId: submission.runId }),
      },
      {
        name: 'inbox',
        run: branch =>
          branch.loop(
            `active-inbox-${submission.runId}`,
            async inboxLoop => processInbox(inboxLoop)
          ),
      },
    ])
  })
}

export default workflow(runWorkflow)
```

Adapt the exact `processInbox` call signature to the queue result while keeping
the outer control flow and durable names unchanged. `workflow/index.ts` should
contain no database query, AI SDK stream construction, catalog call, message
inspection, or terminal-outcome calculation.

The intended workflow dependency direction is:

```text
workflow/index.ts
  └── workflow/steps/index.ts
        ├── process-inbox.ts ──► utils/messages.ts + db/index.ts
        ├── submit-run.ts ─────► title.ts + db/index.ts
        └── execute-run.ts ────► utils/messages.ts
                                 utils/usage.ts
                                 db/index.ts
                                 chat/harness

actions/* ─────────────────────► utils/messages.ts + db/index.ts
```

No step module may import `workflow/index.ts`, and utility modules may not
import workflow, action, lifecycle, actor-context, catalog, or database code.

**Verify**: `wc -l src/runtime/actors/session/workflow/index.ts` → preferably
below 120 lines; `bun run typecheck` → exit 0.

## Step 7: Split persistence by domain without breaking imports

Move implementations out of `db/queries.ts` into:

- `session-meta.ts`: `ensureSessionMeta`, `getSessionMeta`, `setSessionTitle`.
- `messages.ts`: sequence allocation, `listMessages`, `messageExists`,
  `appendMessage`, `appendMessageIfAbsent`, and `replaceMessages`.
- `runs.ts`: terminal statuses, `submitRun`, `updateRun`,
  `requestRunCancellation`, `finalizeRun`, `getRun`,
  `getRunByIdempotencyId`, and `listRuns`.
- `run-frames.ts`: `appendRunFrame` and `listRunFrames`.
- `maintenance.ts`: `deleteSessionData`.

Maintain dependency direction:

```text
session-meta ──► schema/database only
messages ─────► session-meta
run-frames ───► schema/database only
runs ─────────► messages + session-meta + run-frames
maintenance ──► schema/database only
```

`submitRun` and `finalizeRun` must remain single database transactions. Helper
extraction must not cause any part of their message, frame, run, or session-meta
writes to commit independently.

Retain `db/queries.ts` as a compatibility barrel:

```ts
export * from './maintenance'
export * from './messages'
export * from './run-frames'
export * from './runs'
export * from './session-meta'
```

Retain the same exports from `db/index.ts`. Existing direct imports from
`@/runtime/actors/session/db/queries` must continue compiling.

Split database tests by domain only if that improves clarity; retain at least
one integration test proving atomic submit/finalize behavior across tables.

**Verify**:
`bun run typecheck && bun test tests/rivet/session/db` → exit 0 and all database
and migration tests pass.

## Step 8: Give actions the predictable directory slot

Replace `actions.ts` with:

- `actions/deliver.ts`: `deliver`, using shared message utilities and the same
  routing policy as workflow processing where applicable.
- `actions/runs.ts`: `cancel`, `getRun`, and `streamSnapshot`.
- `actions/session.ts`: `getSession`, `setModel`, `setFeatures`, and
  `deleteSession`.
- `actions/index.ts`: default action-map assembly only.

```ts
import { deliver } from './deliver'
import { cancel, getRun, streamSnapshot } from './runs'
import {
  deleteSession,
  getSession,
  setFeatures,
  setModel,
} from './session'

export default {
  cancel,
  deliver,
  deleteSession,
  getRun,
  getSession,
  setFeatures,
  setModel,
  streamSnapshot,
} satisfies SessionActions
```

Do not broaden the public action surface. Ensure `session/index.ts` can continue
using `import actions from './actions'` through directory index resolution.

**Verify**: `bun run typecheck && bun run test` → exit 0 and all tests pass.

## Step 9: Final formatting and verification

Run the repository tools in this order:

1. `bun run format`
2. `bun run lint`
3. `bun run typecheck`
4. `bun run test`
5. `bun run build`

Inspect `git diff --stat` and `git status --short`. Confirm no user-owned TUI,
transport, CLI, or unrelated test change was overwritten or absorbed into this
refactor.

## Test plan

Pure tests that do not start RivetKit:

- `decideInboxRoute`: every priority with and without an active run, including
  manual-approval refusal.
- `messageWithOrigin`: preserves existing object metadata and does not mutate
  the source message.
- `isWaitingForHumanInput`: manual approval, automatic approval, non-assistant
  latest message, and empty transcript.
- `hasAssistantContent` and cutoff construction: content, only `step-start`, and
  missing response.
- `aggregateUsage`: populated, partially undefined, and empty step lists.
- terminal-outcome resolution: cancelled, interrupted, workflow-aborted,
  completed, failed, and missing terminal outcome.

Rivet integration tests:

- Queue submission/deduplication and all three delivery priorities.
- Refused steering fallback to durable queueing.
- Successor-run ordering after interruption.
- Cancellation before and during execution.
- Disconnect/reconnect and durable frame replay.
- Interrupted/stopped assistant cutoff persistence.
- Atomic finalization and transcript revision behavior.

## Done criteria

- [ ] `workflow.ts` and `actions.ts` have been replaced by predictable
  directories with index entry points.
- [ ] `workflow/index.ts` contains orchestration only.
- [ ] `workflow/steps/index.ts` exports only `processInbox`, `submitRun`, and
  `executeRun`.
- [ ] `consumeRunStream` is private inside `execute-run.ts` and is not a nested
  Rivet durable step.
- [ ] Pure routing, message, usage, cutoff, and terminal-outcome decisions have
  tests that do not initialize RivetKit.
- [ ] `db/queries.ts` and `db/index.ts` preserve the existing export surface.
- [ ] `submitRun` and `finalizeRun` retain their atomic transaction boundaries.
- [ ] Existing durable workflow identifiers are unchanged.
- [ ] No schema or migration changes exist.
- [ ] `bun run format`, `bun run lint`, `bun run typecheck`, `bun run test`, and
  `bun run build` all exit 0.
- [ ] `git status --short` contains no unexpected files.
- [ ] The status row in `plans/README.md` is updated.

## STOP conditions

Stop and report instead of improvising if:

- The live working-tree changes in session workflow, actions, queue tests, or
  stream-control tests would be lost or contradicted by a planned move.
- RivetKit requires a different durable step name or a new nested durable step
  to make the extraction compile.
- A context type cannot be expressed without introducing `any`, double casts,
  or copying the entire actor context into a new abstraction.
- Preserving `db/queries.ts`, `db/index.ts`, `./actions`, or `./workflow` import
  compatibility is impossible under the current module resolver.
- `submitRun` or `finalizeRun` would need to cross database transaction
  boundaries.
- The refactor requires a schema migration, event/API change, or edits to the
  transport, TUI, or CLI.
- A verification command fails twice after one reasonable correction.

## Maintenance notes

- Apply this layout to future actors, but do not extract a shared actor
  framework until a second implementation demonstrates concrete duplication.
- Reviewers should scrutinize durable identifier stability, event publication
  order, abort-signal precedence, `activeRun` cleanup, pending steering
  requeueing, and transaction boundaries more closely than line-count goals.
- A module may exceed the suggested 250-line guideline when further splitting
  would hide an atomic transaction or tightly coupled state machine. Cohesion
  is the goal; small files alone are not.
- Promote a local helper to `utils/` only after it becomes pure and shared.
