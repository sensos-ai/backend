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

## Local runtime compatibility

The detached runtime can remain active after the CLI exits. The CLI compares the protocol version and build ID before it reuses that runtime. This check prevents the CLI from using stale runtime code.

Read [`.agents/reference/rivetkit/durable-runs.md`](.agents/reference/rivetkit/durable-runs.md) before changing run execution, runtime activity ownership, stream persistence or replay, cancellation, or CLI session attachment and switching.

- Do not set the build ID by hand. Development computes it from runtime source files. `bun run turbo:build` adds it to the compiled CLI. The CLI uses this identity to decide whether an existing local engine can be reused.
- Run `bun run turbo:build` after source, dependency, or bundled asset changes when you test `dist/sensos`.
- If an incompatible runtime has active leases, close its chats or run `sensos runtime stop`. Then start the CLI again.
