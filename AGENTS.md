# Repository workflow

## Formatting and linting

- Read `package.json` scripts before invoking repository tooling.
- Use the repository's Biome scripts: `bun run format`, `bun run lint`, and `bun run lint:fix`.
- Do not run or introduce Prettier in this repository.

## Testing

Read [`.agents/reference/testing.md`](.agents/reference/testing.md) before
changing or running tests, fixtures, helpers, runners, or test infrastructure.

## Local runtime compatibility

The detached runtime can remain active after the CLI exits. The CLI compares the protocol version and build ID before it reuses that runtime. This check prevents the CLI from using stale runtime code.

- Change `SENSOS_RUNTIME_PROTOCOL_VERSION` in `.env` and `.env.example` when the CLI-to-runtime request or response schema changes. Use the next integer.
- Keep the protocol version unchanged for source changes that do not change this wire contract.
- Do not set the build ID by hand. Development computes it from runtime source files. `bun run build` adds it to the compiled CLI.
- Run `bun run build` after source, dependency, or bundled asset changes when you test `dist/sensos`.
- If an incompatible runtime has active leases, close its chats or run `sensos runtime stop`. Then start the CLI again.
