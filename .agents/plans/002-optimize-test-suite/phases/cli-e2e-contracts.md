# Phase 4: CLI E2E contracts

## Goal

Prove critical user journeys through the compiled CLI, terminal renderer,
runner, transport, Rivet actor, persistence, and scripted provider. A passing
transport or actor test must no longer be treated as proof that its slash
command works.

## E2E harness

Create reusable helpers under `tests/helpers` that:

- build a per-test root containing isolated `HOME`, XDG config/state, workspace,
  logs, and Rivet storage;
- start a per-test scripted gateway on a dynamic port;
- start the compiled `dist/sensos` inside a uniquely named tmux session or an
  equivalently real PTY;
- send literal text and key sequences, capture stable screen output, inspect
  exit status, and enforce bounded waits;
- expose persisted catalog, run, frame, and transcript observations without
  mutating them;
- stop the CLI, supervised runtime, tmux session, fake gateway, and temporary
  root in one idempotent `finally` path.

Follow the FX pattern: terminal and gateway helpers provide mechanics and
observations; each `tests/e2e/cli/*.test.ts` file states the journey and makes
the assertions. CI must install or verify the selected PTY dependency rather
than silently skipping the suite.

## Required journeys

Implemented: `/interrupt`, `/queue`, `/stop`, provider errors after emitted
chunks, malformed stream termination, runtime startup failure, and normal
exit/signal cleanup. Failure cases persist partial output while remaining
distinct from cancellation.

Disconnect/resume and `/switch-session` are implemented in
`tests/e2e/cli/session-resume.test.ts`. The disconnect journey kills the real
CLI while its provider stream is held, proves the runtime and provider work
survive without cancellation, resumes through the compiled command, and
asserts active and queued output appear exactly once. Durable stream offsets
provide ordered replay without making the terminal client own the run.

### `/interrupt <message>`

1. Hold the first model stream after persisted partial reasoning/text.
2. Enter the real slash command while the TUI is streaming.
3. Prove the fake gateway observed cancellation of the original request.
4. Prove the original run became `interrupted`, partial assistant output was
   persisted exactly once, and the interrupt message followed that cutoff.
5. Prove the successor run starts and completes through a second scripted turn.
6. Prove the TUI returns to a usable composer and exits cleanly.

### `/queue <message>`

Prove the queued message is acknowledged but absent from the active model
context and transcript until the held run completes; then prove exactly one new
run starts with that message.

### `/stop`

Prove the active request aborts, the run becomes `cancelled`, partial output is
retained once, no successor user message is created, and a later ordinary
prompt succeeds.

### Disconnect and resume

Terminate the client while the provider remains active, reconnect by the real
resume command, replay ordered frames through `finish`, and prove queued work
continues exactly once.

### Failure recovery

Cover provider failure after partial output, malformed stream termination,
runtime startup failure, and normal signal/exit cleanup with actionable CLI
output and no orphan resources.

## Command and CI changes

- Make `test:e2e` build the executable before running the E2E files, or make the
  CI job run `bun run build` immediately before `bun run test:e2e`.
- Remove `--pass-with-no-tests` as soon as the first required journey lands.
- Add an E2E CI job with a bounded timeout and diagnostic artifact upload for
  terminal capture, fake-gateway request summaries, and runtime logs.
- Keep real-provider smoke tests opt-in and outside the default E2E command.

## Acceptance criteria

- [x] `/interrupt`, `/queue`, and `/stop` are entered through the actual TUI.
- [x] Cancellation is observed at the fake provider boundary and in persisted
  actor state.
- [x] E2E tests fail if the slash parser, command registration, runner callback,
  transport, actor routing, or provider cancellation path is disconnected.
- [x] Each journey passes alone and with the entire E2E directory.
- [x] Successful and failed tests leave no tmux session, CLI process, runtime,
  listener, or temporary product data.
- [x] A hard-disconnected CLI can resume an active durable stream and its queued
  successor without aborting provider work or duplicating transcript output.

References:

- [FX E2E structure](https://github.com/vercel-labs/fx/tree/main/tests/e2e)
- [FX interrupt recovery](https://github.com/vercel-labs/fx/blob/main/tests/e2e/tui-interrupt-recovery.test.ts)
