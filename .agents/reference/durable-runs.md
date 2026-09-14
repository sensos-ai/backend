# Durable runs

Use this guide when changing run execution, runtime supervision, stream transport, cancellation, or CLI session attachment.

## Ownership invariant

The session actor owns an accepted run and drains its provider stream. A connected CLI is only a reader. Losing every reader, switching sessions, or exiting the CLI leaves active and queued work running while the supervised runtime remains healthy.

Keep both layers alive until accepted work settles:

- Register the process-local runtime activity promise with the actor's `keepAwake()` synchronously inside `deliver()`, before acknowledging the inbox delivery. Rivet can ignore task registration after the action's registration window closes.
- Carry that activity ownership through queue routing and provider consumption. Release it only after the delivery is refused, absorbed as steering, or reaches a terminal run state.
- Idle supervisor shutdown waits for both CLI leases and runtime activity to reach zero.
- Session deletion clears its activity entries. Every success, cancellation, and failure path releases its entry.

Preserve queued successors across the terminal handoff between runs, including when no client is attached.

## Stream persistence

Each run owns a native Durable Stream under
`/durable-streams/v1/stream/sensos/runs/<runId>`. The supervised runtime launches
Rivet Services beside the Rivet engine because the engine itself does not serve
the Durable Streams HTTP API. The compiled CLI bundles both executables.

Create the run stream before provider execution. For each ordered
`UIMessageChunk`:

1. Append the frame to the actor's SQLite run-frame log.
2. Append the chunk to the native Durable Stream with a monotonically ordered
   `Stream-Seq` value.
3. Broadcast the frame to connected actor observers.

Finalize the run and its terminal SQLite frame transactionally, then close the
Durable Stream with the same terminal chunk. SQLite remains the authoritative
run/transcript state and actor inspection path; the Durable Stream is the
detachable live and replay transport for CLI readers.

## Reader reconnection

Read `getSession().activeRunId`, then tail that run's native Durable Stream. Do
not add a `resumeRun` action: reconnecting resumes a reader, while the
actor-owned provider request has continued independently.

- A transport records the latest emitted opaque Durable Streams offset for each
  run.
- The same transport reconnects from that offset, so only later batches are
  emitted.
- A fresh transport starts at `-1` and replays the active run from its beginning.
- An offset checkpoints an HTTP batch, not one JSON item. Emit every item in a
  batch before recording its offset; otherwise detachment between items can skip
  the undelivered remainder on reconnect.
- Completed turns hydrate from the SQLite-backed durable transcript. An active
  turn reconnects to its Durable Stream and receives either its replayed history
  or its still-live tail in order, without snapshot/live overlap.

`streamSnapshot(runId, afterSeq)` remains available for actor inspection and
integration assertions. It uses zero-based SQLite frame sequences and is not the
CLI transport's resumable cursor.

## CLI lifecycle

`/switch-session` detaches and disposes the current session connection, returns to the workspace session picker, and attaches to the selected session without releasing the process-wide runtime lease. It does not cancel the current run.

Cancellation is explicit. `/stop` resolves the active run and calls the actor's
cancel action. Ctrl-C while streaming aborts the chat request, which invokes the
same actor cancellation after the run ID is known. Both preserve all chunks
written before cancellation, persist a cutoff assistant message and terminal
abort chunk, close the Durable Stream, and return to the current session
composer. Ctrl-C while idle exits the CLI. Session deletion and explicit runtime
shutdown are also cancellation boundaries.

## Compatibility boundary

This design guarantees stream durability across client detachment while the supervised runtime and Rivet Services sidecar remain healthy. Runtime or machine crash recovery cannot resume an existing provider HTTP response at an exact token boundary.

Actor wake reconciles persisted ownership before accepting more work. A
`cancel_requested` run without a live producer becomes `cancelled`; a `running`
run without a live producer becomes `interrupted`; and its persisted frames are
projected into the cutoff assistant message. Queued work is left intact so the
durable workflow can resume it. Stale `activeRunId` pointers to missing or
terminal runs are cleared.

The same reconciliation runs when a client connects, before session hydration.
Recovery therefore does not require a user command even when a wedged actor has
remained awake. It never takes ownership away from a producer that is live in
the current actor generation.

Runtime activity tracking is intentionally process-local. Keep `SENSOS_RUNTIME_PROTOCOL_VERSION` unchanged when modifying this behavior without changing the CLI-to-runtime request or response schema.

## Verification

Use `bun run turbo:build` before exercising the compiled CLI. Run the narrowest
relevant test during development, then `bun run turbo:check` before handing off
a cross-layer runtime change. The Turbo graph builds `dist/sensos` before its
E2E test leaf.
