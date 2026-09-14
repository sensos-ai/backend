# 002-optimize-test-suite

## Summary

This plan turns the SensOS test suite into a layered reliability system rather
than a large collection of passing tests. It keeps the completed command split,
revises the Rivet integration design around `setupTest` and per-test ownership,
adds programmable model fixtures, and proves user-visible CLI behavior through
real terminal E2E journeys.

The earlier Phase 2 implementation at `9c29cc0` is intentionally superseded.
One command may still own immutable, expensive process resources, but mutable
registry, actor, model-scenario, workspace, and client state belong to the test
that uses them.

## Design references

The target structure combines these proven patterns:

1. [Anthropic Sandbox Runtime](https://github.com/anthropics/sandbox-runtime/tree/main/test)
   keeps reusable process mechanics in
   [`test/helpers`](https://github.com/anthropics/sandbox-runtime/tree/main/test/helpers)
   and inert inputs in
   [`test/fixtures`](https://github.com/anthropics/sandbox-runtime/tree/main/test/fixtures).
2. [Upstash CLI](https://github.com/upstash/cli/tree/main/tests) separates
   `tests/unit`, `tests/integration`, and `tests/helpers`; its CLI helper creates
   a fresh command instance for every invocation.
3. [Clerk CLI](https://github.com/clerk/cli/blob/main/test/e2e/lib/fixture-test.ts)
   shares expensive application setup at file scope while cleaning mutable
   user state after every test.
4. [FX](https://github.com/vercel-labs/fx/tree/main/tests/e2e) keeps fake
   gateways, held streams, terminal control, and cancellation observation in
   E2E helpers. Its
   [`tui-interrupt-recovery.test.ts`](https://github.com/vercel-labs/fx/blob/main/tests/e2e/tui-interrupt-recovery.test.ts)
   drives the real TUI instead of calling the transport beneath it.
5. [Rivet testing guidance](https://rivet.dev/actors/docs/testing/) makes
   `setupTest` the default actor-test boundary and requires independent tests,
   bounded polling of observable state, edge cases, and realistic data.

## Test taxonomy and ownership

```text
tests/
  unit/<product-area>/             pure and dependency-injected contracts
  integration/rivet/<actor>/       actor behavior through setupTest
  e2e/cli/                         compiled CLI and real terminal journeys
  helpers/                         lifecycle, polling, process, and driver APIs
  fixtures/                        inert data and controllable test doubles
    llm/
    rivet/
    workspaces/
```

- A **fixture** is representative input or a controllable dependency: scripted
  chunks, fake gateway responses, malformed files, sample workspaces, or a
  narrowly scoped test actor.
- A **helper** owns reusable mechanics: temporary environments, process
  spawning, terminal interaction, bounded polling, and cleanup.
- A **test file** owns the scenario, actions, and assertions. Helpers may expose
  observations but must not make the feature-level assertion on the test's
  behalf.
- A **test runner** belongs under the relevant `tests/<layer>/` directory and
  exists only when one parent process must own command-wide resources. Fixture
  generation, refresh, audit, and remote cleanup may remain under `scripts/`;
  ordinary test lifecycle and model behavior may not.

## Phases

| phase | status | goal | link |
| --- | --- | --- | --- |
| test-layer-contracts | complete | Establish explicit unit, integration, E2E, stress, coverage, lint, and CI commands. | [View](./phases/test-layer-contracts.md) |
| rivet-test-isolation | complete | Replace the suite-global registry with per-test `setupTest` ownership and align the test tree. | [View](./phases/rivet-test-isolation.md) |
| scripted-model-fixtures | complete | Make streaming, reasoning, tools, failure, and cancellation deterministic per test. | [View](./phases/scripted-model-fixtures.md) |
| cli-e2e-contracts | complete | Prove `/interrupt`, `/queue`, `/stop`, reconnect, and persistence through the real CLI/TUI boundary. | [View](./phases/cli-e2e-contracts.md) |
| parallel-stress-confidence | todo | Prove isolation under parallelism, random ordering, repetition, and process failure. | [View](./phases/parallel-stress-confidence.md) |
| suite-pruning | todo | Remove redundant and low-signal tests while preserving boundary and risk coverage. | [View](./phases/suite-pruning.md) |
| test-governance | in progress | Document the test contract, enforce CI gates, and keep failures diagnosable. | [View](./phases/test-governance.md) |

## Cross-phase invariants

- Default tests make no paid model calls and require no user credentials.
- Every mutable resource has one owner and an idempotent cleanup path.
- Tests synchronize on observable events or bounded polls, never assumed time.
- Dynamic servers bind collision-safe ports; actor identity is unique per test.
- Environment variables configure process boundaries, not scenario semantics.
- Test names describe the highest boundary actually exercised.
- A lower-layer test cannot be cited as proof that a CLI command works.
- `Portless` remains outside the automated path: hostname proxying does not
  provide Rivet engine, namespace, storage, lifecycle, or state isolation.

## Repository verification

Every phase must leave these commands green:

```sh
bun run lint:check
bun run typecheck
bun run test:unit
bun run test:integration
bun run test:e2e
bun run build
git diff --check
```

Run `bun run format` only when implementing a phase, then repeat the
non-writing checks. Keep `SENSOS_RUNTIME_PROTOCOL_VERSION` unchanged unless a
phase changes the CLI-to-runtime wire schema.
