# Phase 6: Suite pruning

## Goal

Reduce test count and maintenance cost without reducing confidence. Retain one
clear test per meaningful contract at the cheapest layer that can prove it,
plus boundary tests for wiring that lower layers cannot observe.

## Audit method

Build a temporary coverage matrix with rows for critical behaviors and columns
for unit, integration, and E2E. Include at least authentication selection,
session creation/resume/deletion, model resolution, streaming, tool calls,
interrupt, queue, stop, reconnect, persistence, runtime lifecycle, and terminal
rendering.

Classify every existing test as:

- **contract**: proves a distinct behavior at the appropriate layer;
- **boundary**: proves components are actually wired together;
- **edge**: proves invalid input, concurrency, or failure handling;
- **duplicate**: repeats another test's boundary and assertions;
- **implementation-coupled**: asserts private sequencing without protecting a
  user or persistence contract;
- **misnamed**: claims a higher boundary than it exercises;
- **flaky**: relies on time, shared state, live network, or test order.

## Pruning rules

- Keep focused unit tests for branching logic and data transformations.
- Keep actor integration tests for queues, workflows, database persistence,
  events, lifecycle, and cancellation state transitions.
- Keep E2E tests only for critical wiring and user journeys.
- Merge repeated setup and polling into helpers without hiding assertions.
- Split omnibus tests when their independent behaviors produce ambiguous
  failures; consolidation is not valuable when one failure prevents several
  contracts from being evaluated.
- Delete a duplicate only after the matrix identifies the retained replacement
  and both tests demonstrably exercise the same boundary and outcome.
- Rename direct actor and transport tests so they cannot be mistaken for CLI
  command coverage.
- Avoid broad snapshots and global coverage percentages. Add targeted coverage
  protection only for critical modules where a regression would otherwise be
  invisible.

## Reliability review

For every retained mock, answer:

1. Which production boundary does it replace?
2. Which behaviors of that boundary are modeled?
3. Which behaviors are intentionally absent?
4. Which integration or E2E test detects mock/production drift?

The fixed test model must not be the sole proof of provider cancellation,
multi-step tools, long streaming, reasoning, malformed data, or request errors.

## Coverage matrix

The retained suite was audited by test name. Each row records the cheapest
contract layer and the higher boundary retained where wiring is material.

| Critical behavior | Unit contract | Integration contract | CLI E2E boundary |
| --- | --- | --- | --- |
| Authentication selection and storage | `cli/auth`: provider credentials stay outside project state; `cli/models`: only supported model IDs and argument routes resolve | — | — |
| Session creation, listing, selection, and deletion | `cli/catalog`: catalog state transitions; `cli/sessions`: list, empty, picker, multi-delete, confirmation, absence polling, and control-plane deletion each cover a distinct command dependency | `session/db/queries`: durable deletion resets actor state | — |
| Session resume and switching | `transport/session-chat-transport`: active/completed replay, offsets, detachment, and readiness; `tui/agent-tui-runner`: hydration and active-stream reconnect; `tui/terminal-renderer`: switch detaches locally | `session/stream-control`: disconnected streams advance and replay | `session-resume`: hard disconnect resumes completed active and queued work once; switch reattaches to the original transcript |
| Model and feature resolution | `harness/features`: environment resolution and explicit precedence; `harness/test-model`: exact enable flag; `rivet/session/lifecycle`: actor feature propagation; `rivet/session/title`: title model selection/retry | — | — |
| Streaming and durable frames | `harness/test-model`: reasoning/text/tool stream and post-tool response; `harness/scripted-model`: isolated scenarios; `workflow/execute-run`: terminal outcome mapping | `scripted-gateway`: native Gateway v4 stream; `session/db/queries`: frames and final metadata persist; `session/stream-control`: replay crosses actor/stream services | failure and resume journeys validate terminal-visible output |
| Tool calls and multi-step turns | fixed model stream shape and post-tool result; scripted model tool-result predicates | native gateway stream serialization | slash-command journeys exercise the real model boundary during active output |
| Interrupt and cancellation | `workflow/process-inbox`: now routing; `transport/session-chat-transport`: abort and explicit stop; `tui/terminal-renderer`: Ctrl-C; fixed and scripted model tests independently observe provider abort | `scripted-gateway`: HTTP cancellation; `session/queue`: now successor; `session/stream-control`: transport stop persistence | `slash-commands`: `/interrupt` reaches provider abort and starts a successor |
| Queue and adaptive steering | inbox routing, transport queued receipt, and harness steering-drain tests cover separate decisions | `session/queue`: adaptive steering and next delivery ordering through the production actor | `slash-commands`: `/queue` defers exactly one user message |
| Stop | command classification, transport stop, runner wiring, and renderer action cover distinct boundaries | transport stop persists the cutoff | `slash-commands`: `/stop` cancels without a successor and keeps input usable |
| Persistence and migrations | migration upgrade/constraints; lifecycle initial state; usage/message utilities | query actor owns active state, final metadata, title, frames, cancellation, and deletion | reconnect and slash-command journeys observe persisted transcripts |
| Provider failures and malformed streams | scripted model produces deterministic provider error and incomplete termination | gateway mismatch diagnostics protect HTTP fixture drift | `failure-recovery`: partial output followed by provider error, and missing finish chunk, remain distinct from abort |
| Runtime lifecycle and assets | runtime lease, compatibility, identity, hashing, and asset integrity tests each protect a separate branch | parallel registry process isolation | `runtime-lifecycle`: startup failure and Ctrl-C both assert no orphan resources |
| Terminal rendering and commands | command completion/exact execution/control classification; renderer switch/Ctrl-C/stop; runner restored messages/title/hydration/reconnect/stop | — | real PTY journeys prove command registration and terminal wiring |
| Platform paths and maintenance | path tests retain one contract per OS/XDG branch; maintenance tests distinguish complete and incomplete managed blocks | — | — |
| Event logging and provider compatibility | middleware event lines and Codex Responses request headers each protect an external contract | — | — |

Tests not named individually in a CLI E2E column are intentionally retained at
their cheaper layer: their test names enumerate distinct branches within the
named file and do not claim terminal wiring.

## Pruning record

- Removed `test model > observes cancellation before the stream controller is
  attached`. The retained replacement is `scripted model > observes aborts
  that fire before stream attachment`, which exercises the same timing edge on
  the programmable fixture. `test model > always observes cancellation without
  an environment flag` remains as the fixed-model cancellation contract.
- Removed duplicate-submit and message-ID fallback-idempotency assertions from
  `queries.integration.test.ts`. The retained replacement is `session queue >
  run submission persists once and deduplicates retries`, which crosses the
  production session actor and checks the persisted message and run identity.
- Retained the query test's busy-run rejection because active-run ownership is
  a distinct database contract, then renamed the test for the state it proves.
- Removed no CLI E2E tests. Each crosses compiled CLI, PTY, runtime, actor, and
  provider wiring for a distinct user-visible journey or failure mode.

## Acceptance criteria

- [x] Every retained test appears once in the coverage matrix with a distinct
  reason to exist.
- [x] Every deleted test names its retained replacement in the phase commit or
  review notes.
- [x] Critical behaviors have at least one contract test and, where wiring is
  material, one higher-boundary test.
- [x] Test names match the boundary exercised.
- [x] The suite is smaller or more focused, while all critical matrix rows
  remain covered.
