# Phase 7: Test governance

## Goal

Make the new reliability model discoverable, enforceable in CI, and easy to
maintain as actors, providers, and CLI commands evolve.

## Testing guide

Add one concise repository testing guide that documents:

- the unit, integration, E2E, stress, coverage, and opt-in live layers;
- the boundary each layer proves and cannot prove;
- the `tests/unit`, `tests/integration`, `tests/e2e`, `tests/helpers`, and
  `tests/fixtures` layout;
- fixture versus helper ownership, including cleanup expectations;
- the scripted model vocabulary and how to assert cancellation;
- Rivet `setupTest` usage and the fresh-registry requirement;
- bounded polling and the ban on assumed-duration correctness sleeps;
- dynamic port and temporary product-data requirements;
- how to reproduce a stress failure from its seed;
- when test-related code may live under `scripts/`.

State explicitly that an abort controller originates in the harness/runner but
must be propagated through the actor workflow to the model request. Therefore a
reliable interrupt test observes both the user-facing outcome and cancellation
at the provider boundary; a model double that ignores its signal cannot prove
interrupt correctness.

## CI policy

- Required PR gates: non-writing lint, typecheck, parallel unit tests, parallel
  integration tests, build, and deterministic E2E.
- Scheduled/manual gate: seeded repeated stress suite.
- Optional credentialed gate: a minimal real-provider compatibility smoke test
  that never blocks ordinary local development and is clearly reported as
  external.
- Upload sanitized diagnostics on failure. Keep temporary artifacts only when
  an explicit debug flag is set; otherwise clean them in `finally`.
- Fail if the E2E command discovers zero tests, if required local dependencies
  are missing in CI, or if an owned process survives cleanup.

## Review checklist

Every new feature or regression fix must identify:

1. the cheapest layer that proves its logic;
2. whether a component boundary also needs integration coverage;
3. whether user-facing wiring needs an E2E journey;
4. whether a new fixture/scenario is representative and isolated;
5. whether cleanup and failure diagnostics are deterministic;
6. whether an existing test now became redundant.

## Acceptance criteria

- [x] A new contributor can choose the correct layer and fixture location from
  the guide without reading test-runner implementation code.
- [ ] CI runs every deterministic layer and cannot report an empty E2E suite as
  success.
- [ ] Test and helper failures print actionable identifiers without credentials
  or full sensitive prompts.
- [ ] The coverage matrix and pruning rationale are linked from the guide and
  updated when critical boundaries change.
- [ ] `scripts/` contains only standalone operational tasks such as fixture
  generation/refresh/audit, remote cleanup, or CI orchestration that cannot be
  owned by the test runner.

References:

- [Anthropic test helpers](https://github.com/anthropics/sandbox-runtime/tree/main/test/helpers)
- [Anthropic inert fixtures](https://github.com/anthropics/sandbox-runtime/tree/main/test/fixtures)
- [Upstash layered test tree](https://github.com/upstash/cli/tree/main/tests)
- [Clerk file-scoped fixture ownership](https://github.com/clerk/cli/blob/main/test/e2e/lib/fixture-test.ts)
- [FX E2E helpers](https://github.com/vercel-labs/fx/blob/main/tests/e2e/tmux-helpers.ts)
- [Rivet testing best practices](https://rivet.dev/actors/docs/testing/)
