# Harness parity implementation plan

## Goal

Bring the Rivet session actor and AI SDK harness close to the mature Pi harness while preserving the newer composable harness architecture. The session actor owns the AgentOS VM, transcript, default model, durable queues, and client connections. A run represents one model invocation/turn and records the model selected for that invocation plus the metadata returned by the AI SDK.

## Current baseline

- The session actor owns and disposes its AgentOS VM.
- SQLite and Drizzle persist session metadata, messages, runs, run frames, and AI SDK step metadata.
- A typed, completable `runs` queue is the submission API.
- `SessionChatTransport` adapts actor events and snapshots to AI SDK chat streams.
- The CLI supports creating, resuming, listing, and deleting sessions, model selection, slash commands, and the test model.
- The focused `runs` queue integration test passes creation, persistence, idempotent resubmission, canonical run ID reuse, and transcript deduplication.

Pre-Milestone 0 performance baseline captured on 2026-09-13:

- `bun run sensos:dev sessions list` rendered its picker in approximately 1.77 seconds because it prepared assets, materialized and booted Rivet, started the registry, listed actors, and read every actor title before rendering.
- `fx sessions` completes in approximately 3 milliseconds because it reads a local session index without booting an actor runtime.

## Milestone 0: Authoritative local session catalog and supervised runtime

### Completed

Milestone 0 established a process-wide SQLite/Drizzle session catalog at the Sensos product-data root and made it authoritative for session identity, actor binding, title, timestamps, revisions, and deletion state. Actor state remains authoritative for runtime configuration and the session-owned AgentOS VM; actor-local SQLite remains authoritative for transcripts, runs, frames, and interaction data.

Session creation now reserves a catalog-generated `chat_*` ID before actor creation. Actor lifecycle hooks bind and reconcile the catalog record, touch access timestamps, reject tombstoned sessions, and preserve VM ownership boundaries. Title and deletion mutations are catalog-first and revision checked. Legacy local data was deliberately removed rather than migrated.

The CLI lists and confirms deletion directly from the catalog without starting Rivet or waking actors. Runtime-dependent work uses a supervised, leased warm runtime with idle shutdown, ownership-checked cleanup, status/stop commands, concurrent AgentOS preparation, and reusable versioned Rivet assets. Session discovery no longer performs `/actors` enumeration or N+1 actor reads.

Relevant implementation:

- [`catalog/index.ts`](/Users/nicolas/Projects/sensos-v2/backend/src/sensos/catalog/index.ts)
- [`catalog/schema.ts`](/Users/nicolas/Projects/sensos-v2/backend/src/sensos/catalog/schema.ts)
- [`runtime.ts`](/Users/nicolas/Projects/sensos-v2/backend/src/sensos/runtime.ts)
- [`runtime-assets.ts`](/Users/nicolas/Projects/sensos-v2/backend/src/sensos/runtime-assets.ts)
- [`sessions.ts`](/Users/nicolas/Projects/sensos-v2/backend/src/sensos/sessions.ts)
- [`lifecycle.ts`](/Users/nicolas/Projects/sensos-v2/backend/src/registry/actors/session/lifecycle.ts)

### Remaining implementation detail

Harden concurrent runtime leasing: prove that multiple CLI processes share one supervisor, maintain independent leases, and cannot trigger idle shutdown while another lease remains active. Keep PID/socket recovery ownership-checked, release ports on shutdown, and preserve the rule that catalog-only commands never require the runtime.

Measure catalog latency separately from runtime readiness. Capture p50/p95 for cold picker, cold resume, warm resume, deletion, and shutdown. The initial cold picker target remains under 100 ms; tighten it only after repeated measurements establish a stable baseline.

### Verification and performance budgets

- [x] Catalog migrations serialize with `BEGIN IMMEDIATE` and are safe across repeated CLI starts.
- [x] Session reservation plus retried actor creation produces one catalog row and one actor identity.
- [x] Catalog revisions deterministically win over stale actor summary state on wake.
- [x] Title changes are catalog-first and visible without booting Rivet.
- [x] Actor-owned default-model, workspace, instructions, transcript, and VM behavior remain independent of catalog synchronization.
- [x] Tombstoned sessions are filtered from discovery and destroy on actor wake.
- [x] Legacy data was deleted; there is intentionally no import path.
- [x] `sessions list` performs no Rivet, registry, actor action, engine materialization, or AgentOS work before an available-session picker renders.
- [x] A cancelled picker releases its lease; the managed warm runtime then follows its idle TTL and removes its owned socket and listener.
- [x] Warm-runtime shutdown releases all ports and removes only owned PID/socket files.
- [ ] Prove multiple CLI processes share one supervised runtime without stopping it while another lease is active.
- [ ] Measure time-to-picker independently from time-to-runtime-ready. Target a cold time-to-picker under 100 ms before setting a tighter budget from repeated measurements.
- [ ] Benchmark cold resume, warm resume, list, deletion, and shutdown with p50/p95 samples.

### Queue semantics and invariants

Rivet removes an actor queue message when it is received, not when `complete()` is called. `complete()` supplies the response for a sender using `wait: true`; it is not an acknowledgement that controls message retention.

The existing `runs` implementation remains correct because its receive is part of a durable workflow loop, run creation is performed in a replay-safe workflow step, and SQLite uniquely constrains `idempotencyId`:

```ts
const queued = await loop.queue.next('next-run', {
  names: ['runs'],
  completable: true,
})

const submission = await loop.step('submit-run', async step => {
  return submitRun(step.db, {
    runId: createRunId(),
    idempotencyId: queued.body.idempotencyId,
    model: queued.body.model,
    message: queued.body.message,
  })
})

await queued.complete(submission)
```

`queued.complete(submission)` intentionally tells the transport that the run was accepted; it does not wait for model execution. If the caller times out and retries, the same client-generated `idempotencyId` resolves to the existing canonical `run_*` record.

References:

- [Rivet actor queues](https://rivet.dev/actors/docs/queues/)
- [Rivet workflow queues](https://rivet.dev/workflows/docs/queues/)
- [Rivet workflow loops](https://rivet.dev/workflows/docs/quickstart/#loops)

## Milestone 1: Human interaction within a run

- [ ] Add `waiting_for_input` to the run state machine without creating a second run for the response.
- [ ] Add a discriminated continuation command for question answers and tool approval decisions.
- [ ] Persist pending and resolved interactions in a `run_interactions` Drizzle table. Enforce first-answer-wins atomically.
- [ ] Port `ask_user_question` with the same question, option, validation, cancellation, and answer shapes as the Pi implementation.
- [ ] Support AI SDK native tool approvals and configurable approval policies.
- [ ] Extend `SessionChatTransport`, the TUI, and the future React client to render pending interactions and submit continuations.
- [ ] Ensure a paused interaction survives actor sleep/restart and resumes the same logical `run_*`.

Reference implementations:

- [`pi-ask-user-question.ts`](/Users/nicolas/Projects/sensos/packages/harness-pi/src/pi-ask-user-question.ts)
- [`pi-permissions.ts`](/Users/nicolas/Projects/sensos/packages/harness-pi/src/pi-permissions.ts)
- [`chat-asks.ts`](/Users/nicolas/Projects/sensos/apps/backend/src/desktop/chat-asks.ts)
- [`chat-approvals.ts`](/Users/nicolas/Projects/sensos/apps/backend/src/desktop/chat-approvals.ts)
- [`approval-policies.ts`](/Users/nicolas/Projects/open-harness/registry/core/approval-policies.ts)
- [Open Harness approval model](/Users/nicolas/Projects/open-harness/docs/concepts/approval-and-trust.mdx)

## Milestone 2: Delivery priority and active-run steering

### Durable queue design

Use one typed `inbox` queue for messages delivered to a session from any producer: the connected chat client, another session, a system event, or a future integration. This queue is not a cross-session abstraction. Its responsibility is deciding whether an incoming message steers the current run or becomes a later run.

Priority is a property of each message, while the existing `runs` queue holds work that must execute as a future turn. Origin is separate from priority and is used only for attribution and authorization.

```ts
const inboxMessageSchema = z.object({
  id: z.string(),
  priority: z.enum(['now', 'next', 'adaptive']),
  message: z.custom<UIMessage>(),
  createdAt: z.number(),
  origin: z.discriminatedUnion('type', [
    z.object({ type: z.literal('client'), clientId: z.string() }),
    z.object({ type: z.literal('session'), sessionId: z.string() }),
    z.object({ type: z.literal('system') }),
  ]),
})

export type InboxMessage = z.input<typeof inboxMessageSchema>

export const queues = {
  runs: createQueue(runCommandSchema, runCompletionSchema),
  inbox: createQueue(inboxMessageSchema),
}
```

Do not add `inboxNow`, `inboxNext`, and `inboxAdaptive` schemas. Do not store a second pending inbox in actor state or SQLite.

Routing rules:

```ts
async function routeInboxMessage(
  context: SessionWorkflowContext,
  inboxMessage: InboxMessage
) {
  switch (inboxMessage.priority) {
    case 'now':
      await steerActiveRun(context, inboxMessage)
      return

    case 'next':
      await context.queue.send('runs', toRunCommand(inboxMessage))
      return

    case 'adaptive':
      if (context.vars.activeRun) {
        await steerActiveRun(context, inboxMessage)
      } else {
        await context.queue.send('runs', toRunCommand(inboxMessage))
      }
  }
}
```

The delivery contract is producer-independent:

| Priority | Active run | Waiting for human input | Idle session |
| --- | --- | --- | --- |
| `now` | Steer the active tool loop | Refuse or report that immediate steering is unavailable | Start a run |
| `next` | Enqueue in `runs` for the next turn | Enqueue in `runs` | Enqueue without bypassing older work |
| `adaptive` | Steer like `now` | Enqueue like `next` | Start a run |

The `inbox` consumer must remain able to route messages while model execution is active. Do not simply add an inbox receive after the current blocking `execute-run` step: that would make `now` indistinguishable from `next`. Implement the intake as a workflow-safe concurrent receive/race or split model execution into durable inference slices so inbox messages can be received between slices.

### Tool-loop steering

- [ ] Expose a run-local steering input to `createHarness`.
- [ ] Drain accepted `now`/active `adaptive` messages at the next AI SDK `prepareStep` boundary.
- [ ] Append steering messages to the model input with origin attribution; session attribution is present only when the producer is another session.
- [ ] Preserve the same `run_*` ID for all inference slices in that logical turn.
- [ ] Do not commit a `next` message to the current run transcript; converting it to a `runs` command makes it a new turn.

`prepareStep` controls the next model step of an already-running tool loop. It does not wake an idle session or select queue entries by payload. Rivet queues provide wakeup and durable scheduling; the harness consumes only the messages the actor has routed into the active run.

Reference implementations:

- [`chat-delivery.ts`](/Users/nicolas/Projects/sensos/apps/backend/src/desktop/chat-delivery.ts)
- [`chat-steering.ts`](/Users/nicolas/Projects/sensos/apps/backend/src/desktop/chat-steering.ts)
- [`session.ts`](/Users/nicolas/Projects/sensos/apps/backend/src/agent/session.ts)
- [`webhook-router.ts`](/Users/nicolas/Projects/sensos/packages/agent-tui/src/webhook-router.ts)

### Verification

- [ ] Prove a `next` message submitted during a run becomes a later `runs` item and is not injected into the active model context.
- [ ] Prove a `now` message reaches the next available `prepareStep` boundary of the same run.
- [ ] Prove `adaptive` selects steering while active and a new run while idle.
- [ ] Prove inbox and resulting run work survive actor sleep/restart.
- [ ] Prove duplicate delivery submissions do not duplicate transcript messages or runs.
- [ ] Prove delivery from a failed producer cannot deadlock the target session.

## Milestone 3: Cross-session communication

Cross-session communication is a producer of session deliveries, not the owner of delivery priority. Its tools locate a target, authorize the send, attach peer attribution, and publish a message to the target's typed `inbox`. The target session then applies the same `now`/`next`/`adaptive` rules used for client or system messages.

### Session tools and attribution

- [ ] Add `list_sessions` with session ID, title, status, and project/workspace metadata.
- [ ] Add `get_session` for bounded transcript/status inspection.
- [ ] Add `message_session` accepting the target session, message, and priority.
- [ ] Generate a prefixed `inbox_*` message ID with the shared ID utility and set `origin: { type: 'session', sessionId }`.
- [ ] Include source session ID/title in tool results and model-visible attribution.
- [ ] Make actor-to-actor sends fire-and-forget. Never use `wait: true` between actors because it can deadlock reciprocal communication.
- [ ] Add idempotency handling for retried sends without making the inbox an SQLite-backed mailbox.

Reference implementations:

- [`message-session.ts`](/Users/nicolas/Projects/sensos/apps/backend/src/mcp/tools/message-session.ts)
- [`list-sessions.ts`](/Users/nicolas/Projects/sensos/apps/backend/src/mcp/tools/list-sessions.ts)
- [`get-session.ts`](/Users/nicolas/Projects/sensos/apps/backend/src/mcp/tools/get-session.ts)
- [`chat-peers.ts`](/Users/nicolas/Projects/sensos/apps/backend/src/desktop/chat-peers.ts)
- [`pi-agent-comms.ts`](/Users/nicolas/Projects/sensos/packages/harness-pi/src/pi-agent-comms.ts)

### Verification

- [ ] Prove session A can deliver each priority to session B with correct attribution.
- [ ] Prove a failed or sleeping target cannot deadlock the sender.
- [ ] Prove authorization can be added without changing the delivery queue contract.

## Milestone 4: Composable harness surface

- [ ] Split the current harness factory into independently composable model, instructions, tools, sandbox, approval policy, interaction, steering, and lifecycle blocks.
- [ ] Keep `initialMessages?: UIMessage[]` on every harness factory and adapter.
- [ ] Define a stable harness result contract consumed by the session workflow, TUI, CLI, and future React transport.
- [ ] Keep AgentOS as the local sandbox implementation and pass the session-owned VM into tools.
- [ ] Make tool registration additive and typed instead of hard-coded in one factory.

References:

- [`harness.ts`](/Users/nicolas/Projects/open-harness/registry/core/harness.ts)
- [Open Harness `createHarness` reference](/Users/nicolas/Projects/open-harness/docs/reference/create-harness.mdx)
- [`harness-seam.ts`](/Users/nicolas/Projects/sensos/packages/agent-tui/src/harness-seam.ts)

## Milestone 5: Subagents

- [ ] Add a spawn tool whose child receives a bounded task, parent/session attribution, inherited workspace access, and explicit lifecycle ownership.
- [ ] Use separate actors/sessions for child agents rather than sharing the parent's active run.
- [ ] Deliver child progress and completion through the producer-independent session delivery contract.
- [ ] Define cancellation, orphan cleanup, maximum concurrency, and failure reporting.
- [ ] Surface subagent events consistently in the TUI and chat transport.

References:

- [`spawn-subagent.ts`](/Users/nicolas/Projects/sensos/apps/backend/src/desktop/spawn-subagent.ts)
- [`chat-subagent-report.ts`](/Users/nicolas/Projects/sensos/apps/backend/src/desktop/chat-subagent-report.ts)
- [Pi subagent example](/Users/nicolas/Projects/sensos/node_modules/@mariozechner/pi-coding-agent/examples/extensions/subagent)

## Milestone 6: Remaining client and production parity

- [ ] Add the React `useChat` integration on top of `SessionChatTransport`, including replay, status mapping, cancellation, questions, and approvals.
- [ ] Add future connection authentication and authorize session reads, sends, cancellation, model changes, and deletion.
- [ ] Package AgentOS runtime/software assets into the compiled CLI without host-global assumptions.
- [ ] Add structured but quiet-by-default CLI logging and explicit debug mode.
- [ ] Verify normal exit, `/exit`, `/delete`, bulk deletion, signals, and failed startup leave no orphan actor engines, VMs, listeners, or ports.
- [ ] Add restart tests around queue receipt, run creation, execution, interaction waits, and terminal frame publication.

## Implementation order

1. ~~Authoritative local session catalog, lifecycle reconciliation, and clean legacy-data cutover.~~
2. ~~Immediate catalog-backed picker, concurrent runtime acquisition, and removal of actor-list N+1 reads.~~
3. ~~Versioned runtime assets and the supervised warm-runtime lease protocol.~~
4. Human questions and approvals, because they establish the continuation contract used by both clients and agents.
5. Producer-independent delivery priority and active-run steering, including its workflow concurrency proof.
6. Cross-session discovery, tools, attribution, and authorization on top of the delivery contract. Session discovery uses the catalog rather than waking every actor.
7. Composable harness extraction after interaction and steering inputs are known.
8. Subagents built on the cross-session contract.
9. React integration and remaining production/packaging work.
