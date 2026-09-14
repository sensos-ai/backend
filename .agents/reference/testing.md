# Testing

Use tests as boundary evidence: a passing test proves only the highest product
boundary it actually crosses. Read `package.json` before running commands.

## Layers

- `tests/unit/<product-area>` owns pure logic and dependency-injected contracts.
  It must not require Rivet, subprocesses, ports, persistent product state, or
  credentials.
- `tests/integration/rivet/<actor>` owns actor behavior through a real local
  Rivet registry and engine. It proves actor, persistence, and transport
  integration, but not CLI command registration or terminal behavior.
- `tests/e2e/cli` owns critical journeys through the compiled `dist/sensos`, a
  real PTY, runtime, actor, persistence, and scripted provider. Only this layer
  proves that a user-facing CLI or slash command is wired end to end.
- Stress and coverage commands are diagnostic layers. Use stress runs for
  concurrency/order-sensitive cases and preserve any reported seed. Use
  coverage to find untested critical paths, not to optimize a global number.
- Real-provider smoke tests are opt-in, credentialed compatibility checks. They
  never belong to the default deterministic suite.

Put scenario actions and feature assertions in the test file. Put reusable
lifecycle, polling, process, terminal, and observation mechanics in
`tests/helpers`. Put inert representative inputs and controllable dependencies
such as scripted model scenarios, malformed payloads, sample workspaces, and
test actors in `tests/fixtures`. A layer-specific runner belongs below that
layer only when one parent process must coordinate command-wide resources.

## Isolation and lifecycle

Each test owns every mutable resource it creates: actor identity, registry,
model scenario, workspace, environment, ports, durable state, clients, and
processes. Generate unique actor keys and temporary product roots per test;
bind collision-safe dynamic ports. Shared immutable process setup is acceptable
only when mutable state remains isolated and is reset after every test.

Rivet integration tests use `setupTest` through the repository Rivet helper.
The individual test owns a fresh registry and disposes every returned client,
connection, actor, and registry in an idempotent cleanup path. Do not add
suite-global registries or environment switches that change scenario behavior.

Cleanup belongs in `finally`. Successful and failed tests must leave no CLI,
PTY controller, runtime supervisor, registry, engine, listener, actor, client,
temporary workspace, or product state behind. Cleanup failures are test
failures, not warnings.

## Deterministic model scenarios

Use the scripted provider fixtures for streaming text, reasoning, tool calls,
held streams, errors, and malformed termination. Define the complete scenario
inside the test and assert that every scripted turn was consumed. Scenario
state is per test; never coordinate it through mutable process-wide flags.

An abort controller may originate in the CLI harness or runner, but the signal
must propagate through transport and actor workflow to the model request. An
interrupt test therefore asserts both the user-visible/persisted result and an
abort observed at the scripted provider boundary. A double that ignores its
abort signal cannot prove cancellation.

## Synchronization and E2E

Synchronize on observable events, state, output, or bounded polling. A short
sleep may yield execution or establish a deliberate negative window, but it
must not be the proof that an asynchronous operation completed. Every wait has
a timeout and a description that identifies the awaited condition.

CLI E2E tests build first, create isolated HOME/XDG/workspace/state roots, and
drive the compiled executable through the real PTY helper. Send literal input
and control keys, assert terminal output plus durable/provider observations,
and exit through the user path when the journey permits. Do not replace a CLI
journey with direct calls to its parser, runner, transport, or actor.

## Local loop

Run the narrowest relevant test while developing, then widen according to the
boundary changed:

```sh
bun test --no-orphans path/to/test.ts
bun run test:unit
bun run test:integration
bun run test:e2e
bun run typecheck
bun run lint:check
git diff --check
```

`test:e2e` builds the executable. Run `bun run build` explicitly before manual
checks of `dist/sensos`. Run the complete deterministic sequence before handing
off a phase or a cross-layer change; use `test:stress` when concurrency,
ordering, cancellation, or lifecycle behavior changed.

Keep CI simple during rapid pre-launch development: it should exercise the
same deterministic commands, reject empty required suites, and retain useful
failure diagnostics.

## Scripts, pruning, and diagnostics

Test lifecycle stays under `tests`. Code under `scripts/` is appropriate only
for standalone operational work such as generating or refreshing fixtures,
auditing the suite, cleaning remote resources, or command-wide CI orchestration
that a test runner cannot own.

Before adding coverage, identify the risk and highest boundary proved. Prefer
one strong contract over several tests that repeat the same implementation
detail. Remove tests whose behavior and failure signal are fully subsumed by a
clearer test, while retaining distinct edge cases, boundary wiring, regression
causes, and failure modes. Never prune solely to reduce count or runtime.

On failure, inspect the sanitized artifacts under `tests/e2e/artifacts`:
terminal capture, scripted-gateway requests and aborts, and runtime logs. Error
messages should include scenario/run identifiers and bounded-wait descriptions,
without credentials or unnecessary full prompts. Temporary product data is
still removed by the owning cleanup path.
