# Repository workflow

## Formatting and linting

- Read `package.json` scripts before invoking repository tooling.
- Use `bun run format` and `bun run lint` when applying Biome fixes.
- Use the cached `bun run turbo:lint` command for read-only lint validation.
- Do not run or introduce Prettier in this repository.

## Task orchestration

- This is a single-package workspace. Use the dedicated `turbo:*` scripts in
  `package.json` for cached builds and validation.
- Use `bun run turbo:check` for the complete parallel validation suite. Use
  `turbo:build`, `turbo:lint`, `turbo:typecheck`, or `turbo:test` when only that
  boundary is relevant.
- Keep task dependencies in `turbo.jsonc`; do not reproduce them with shell
  command chains in new scripts.

## Testing

Read [`.agents/reference/testing.md`](.agents/reference/testing.md) before
changing or running tests, fixtures, helpers, runners, or test infrastructure.

## Engine runtime

Read [`.agents/reference/rivetkit/durable-runs.md`](.agents/reference/rivetkit/durable-runs.md)
before changing actor execution, runtime activity ownership, stream persistence
or replay, or cancellation.

- This repository builds and hosts `sensos-engine`; it does not own the CLI.
- `@sensos-ai/shared` is installed under `sensos/shared` and owns the public
  wire contract. Do not recreate protocol sources in the backend.
- Do not set the engine build ID by hand. Development computes it from engine
  source files; `bun run turbo:build` embeds it in `dist/sensos-engine`.
