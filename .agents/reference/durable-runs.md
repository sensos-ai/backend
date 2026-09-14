# Durable runs

Use this guide when changing run execution, runtime supervision, stream transport, cancellation, or CLI session attachment.

## Ownership invariant

The session actor owns an accepted run and drains its provider stream. A connected CLI is only a reader. Losing every reader, switching sessions, or exiting the CLI leaves active and queued work running while the supervised runtime remains healthy.

Keep both layers alive until accepted work settles:

- Provider consumption runs inside the actor's `keepAwake()` scope.
- Process-local runtime activity is retained before an inbox delivery is acknowledged and released only after the delivery is refused, absorbed as steering, or reaches a terminal run state.
- Idle supervisor shutdown waits for both CLI leases and runtime activity to reach zero.
- Session deletion clears its activity entries. Every success, cancellation, and failure path releases its entry.

Persist each ordered `UIMessageChunk` as a run frame before broadcasting it. Preserve queued successors across the terminal handoff between runs, including when no client is attached.

## Reader reconnection

Use the existing replay contract: read `getSession().activeRunId`, then call `streamSnapshot(runId, afterSeq)`. Do not add a `resumeRun` action; replay reconnects a reader, while the actor-owned provider stream has continued independently.

- A transport records the highest emitted sequence for each run.
- The same transport reconnects after that sequence.
- A fresh CLI transport starts at `-1` and rebuilds the active assistant message from persisted frames.
- Completed turns hydrate from the durable transcript.
- Snapshot and live-event overlap must remain ordered and duplicate-free.

## CLI lifecycle

`/switch-session` detaches and disposes the current session connection, returns to the workspace session picker, and attaches to the selected session without releasing the process-wide runtime lease. It does not cancel the current run.

Cancellation is explicit. `/stop` and Ctrl-C while streaming cancel the active run, wait for its persisted cancelled cutoff, and return to the current session prompt. Ctrl-C while idle exits the CLI. Session deletion and explicit runtime shutdown are also cancellation boundaries.

## Compatibility boundary

This design guarantees stream durability across client detachment while the supervised runtime remains healthy. Runtime or machine crash recovery cannot resume an existing provider HTTP response at an exact token boundary and is outside this contract.

Runtime activity tracking is intentionally process-local. Keep `SENSOS_RUNTIME_PROTOCOL_VERSION` unchanged when modifying this behavior without changing the CLI-to-runtime request or response schema.
