# Sensos Distribution and Release Plan

## Goal

Distribute Sensos as a self-contained native CLI that users install with:

```sh
curl -fsSL https://sensos.sh/setup.sh | bash
```

The installed `sensos` command must not require Bun, a repository checkout, or
`node_modules`. The installer replaces `bun link` for production-style usage.
`sensos-dev` remains a repository-only development command.

## Current state

- `bun run build:sensos` compiles `src/sensos/bootstrap.ts` to `dist/sensos`.
- The compiled binary embeds the Rivet engine, AgentOS sidecar, and AgentOS
  software packages and materializes them into Sensos-owned runtime storage.
- `package.json` exposes `sensos` from `dist/sensos` and `sensos-dev` from the
  TypeScript entrypoint.
- `sensos uninstall` resets product data, removes known command shims, attempts
  legacy Bun unlink cleanup, and removes complete Sensos-managed shell blocks.
- The native build currently selects macOS ARM64 assets directly. Multi-platform
  releases are not ready yet.

## Command roles

| Command | Purpose | Requires repository | Requires Bun |
| --- | --- | ---: | ---: |
| `sensos` | Installed production CLI | No | No |
| `sensos-dev` | Fast TypeScript development CLI | Yes | Yes |
| `bun run build:sensos` | Build the local native binary | Yes | Yes |
| `scripts/setup.sh --local ./dist/sensos` | Test the real installation layout | Yes | Only to build first |

`sensos-dev` must never be included in public release archives. It may continue
to be exposed through `bun link` for repository development.

## Local development flow

Use source mode while changing CLI or actor behavior:

```sh
bun install
bun link
sensos-dev --test-model
```

Source mode runs `src/sensos/bootstrap.ts` through Bun. It is optimized for a
short edit/run cycle and does not validate release packaging.

Before handing off changes:

```sh
bun run typecheck
bun test
bun run build:sensos
```

`bun unlink` removes the repository development link. It is not part of the
production installation or uninstall contract.

## Local production-style flow

This flow validates the same binary location and PATH behavior used by a real
download without publishing a release:

```sh
bun run build:sensos
./scripts/setup.sh --local ./dist/sensos
sensos --version
sensos --test-model
```

The local installer must copy the binary rather than symlink it. Rebuilding or
deleting the repository must not change the installed command.

Test cleanup with:

```sh
sensos uninstall
```

After uninstalling, an already-running shell may retain a cached command path.
The CLI should advise zsh users to run `rehash`, bash users to run `hash -r`, or
all users to open a new terminal. The child CLI cannot modify its parent shell's
in-memory command cache.

## Production installation flow

The public flow is:

```sh
curl -fsSL https://sensos.sh/setup.sh | bash
sensos
```

The installer must:

1. Run with `set -euo pipefail`.
2. Detect supported OS and architecture combinations.
3. Resolve an explicit version argument or fetch `latest.txt`.
4. Download the matching archive and checksum manifest over HTTPS.
5. Verify the archive's SHA-256 digest before extraction.
6. Extract into a temporary directory and clean it through an exit trap.
7. Validate that the archive contains one regular `sensos` executable.
8. Install through a temporary file and atomic rename into
   `${SENSOS_INSTALL_DIR:-$HOME/.local/bin}/sensos`.
9. Preserve the previous binary until verification succeeds.
10. Add the install directory to PATH only when it is absent.
11. Mark shell configuration with paired, Sensos-owned comments.
12. Print the installed version and shell activation instructions.

Managed POSIX shell block:

```sh
# >>> sensos >>>
export PATH="$HOME/.local/bin:$PATH"
# <<< sensos <<<
```

Managed fish block:

```fish
# >>> sensos >>>
fish_add_path "$HOME/.local/bin"
# <<< sensos <<<
```

The installer must not add a block when the directory is already available in
PATH. It must never remove or rewrite generic Bun, Homebrew, or user-owned PATH
configuration.

Supported installer forms:

```sh
# Latest stable version
./scripts/setup.sh

# Explicit version
./scripts/setup.sh v0.1.0

# Locally compiled binary
./scripts/setup.sh --local ./dist/sensos

# Custom destination
SENSOS_INSTALL_DIR=/custom/bin ./scripts/setup.sh
```

## Filesystem ownership

The install directory contains only the executable. Product directories are
created lazily on first use.

Sensos follows OS-native locations through `src/sensos/paths.ts`:

| Platform | Configuration | Runtime state |
| --- | --- | --- |
| Linux/XDG | `$XDG_CONFIG_HOME/sensos` | `$XDG_STATE_HOME/sensos` |
| Linux fallback | `~/.config/sensos` | `~/.local/state/sensos` |
| macOS | `~/Library/Application Support/sensos` | `~/Library/Application Support/sensos` |
| Windows | `%APPDATA%/sensos` | `%LOCALAPPDATA%/sensos` |

Runtime state includes the session catalog, actor data, logs, supervised runtime
metadata, and materialized native assets. Installation must not create or reset
these directories.

## Release artifacts

Each release should publish:

```text
sensos-macos-aarch64.tar.gz
sensos-macos-x86_64.tar.gz
sensos-linux-aarch64.tar.gz
sensos-linux-x86_64.tar.gz
checksums.txt
latest.txt
```

Windows should be added only after the actor runtime, AgentOS sidecar, process
supervisor, filesystem paths, and terminal UI are verified there. Its eventual
artifact should be named `sensos-windows-x86_64.zip`.

Archives should contain:

```text
sensos
LICENSE
THIRD_PARTY_NOTICES.md
```

Release binaries should expose their build version and commit through:

```sh
sensos --version
```

## Build architecture changes

### 1. Make native assets target-aware

Replace the hard-coded Darwin ARM64 paths in `scripts/build-sensos.ts` and
`src/sensos/runtime-assets.ts` with an explicit build target manifest. Each
target must select matching Rivet engine and AgentOS sidecar packages.

The build must fail when any required target asset is missing. It must not fall
back to a host-native binary while cross-compiling.

### 2. Keep all runtime assets self-contained

For every target, confirm the compiled binary can materialize:

- Rivet engine;
- AgentOS sidecar;
- AgentOS software packages;
- actor database migrations; and
- any TUI or prompt assets loaded at runtime.

No production path may depend on `import.meta.dir`, the source tree,
`node_modules`, or the build machine's absolute paths.

### 3. Make extraction content-addressed and atomic

Continue embedding asset digests. Materialized filenames should include their
digest so upgrades can coexist safely with a running older process. Write to a
temporary file, sync, chmod, and atomically rename it into place.

Old extracted assets can be pruned only when no supervised runtime uses them.

### 4. Add release metadata

Inject the semver, commit SHA, build target, and build timestamp during compile.
Expose semver in `sensos --version` and include the remaining values in
diagnostic output.

## Uninstallation

### User-facing entry points

The normal entry point remains visible in CLI help:

```sh
sensos uninstall
```

The release CDN should also publish a recovery entry point:

```sh
curl -fsSL https://sensos.sh/uninstall.sh | bash
```

The CLI command is canonical because it can ask the actor runtime to delete its
sessions cleanly before removing files. The standalone script exists for a
damaged, incompatible, or partially removed binary. It should locate an
installed `sensos` and invoke `sensos uninstall` when that executable is usable;
otherwise it performs a receipt-driven filesystem cleanup without attempting
actor lifecycle calls.

Do not maintain two unrelated lists of files to delete. The setup script must
write an installation receipt, and both uninstall entry points must derive their
installation-specific targets from it.

### Installation receipt

After installing successfully, `setup.sh` should atomically write a small JSON
receipt under the Sensos configuration directory:

```json
{
  "schemaVersion": 1,
  "version": "0.1.0",
  "installDir": "/Users/example/.local/bin",
  "executable": "/Users/example/.local/bin/sensos",
  "profileFiles": ["/Users/example/.zshrc"],
  "profileBlock": "sensos"
}
```

The receipt records ownership; it does not grant arbitrary deletion authority.
Every path must still be validated at uninstall time. The CLI must load the
receipt before resetting product configuration, retain it in memory, and delete
the receipt last.

The receipt is especially important for `SENSOS_INSTALL_DIR`, paths containing
spaces, and future installation layouts. Legacy Bun links are discovered
separately because they predate the receipt.

### Canonical uninstall sequence

`sensos uninstall` should be safe, deterministic, and idempotent:

1. Load and validate the installation receipt without deleting anything.
2. Resolve every product-owned target and reject unsafe or malformed paths.
3. Stop the supervised runtime and confirm that it exited.
4. Delete all actors concurrently and hard-purge the session catalog.
5. Remove Sensos state, caches, logs, materialized assets, and configuration.
6. Remove complete Sensos-managed blocks from every recorded and supported shell
   profile.
7. Remove the exact installed executable and installer-owned support files.
8. Attempt legacy `bun unlink` cleanup only when Bun and a Sensos package link
   both exist.
9. Report any remaining targets and exit non-zero on partial failure.
10. Print `Successfully uninstalled.` only when all required operations succeed.

Resolve and validate all targets before step 3 so a corrupt receipt cannot cause
a half-finished uninstall before its unsafe path is detected. Runtime/session
cleanup may discover operational failures later; those should be reported as
partial failures rather than concealed.

### Deletion safety rules

- Only remove an executable whose basename is exactly `sensos` and whose parent
  equals the validated installation directory.
- Reject empty paths, filesystem roots, home itself, relative paths, and paths
  containing unresolved traversal.
- Use `lstat` for deletion targets. Remove a symlink itself; never follow it and
  delete its destination.
- Remove only paired `# >>> sensos >>>` through `# <<< sensos <<<` blocks.
- Never remove generic Bun, Homebrew, system, or user-authored PATH setup.
- Treat missing files, profiles, product directories, actors, and catalog rows
  as already removed.
- Do not recursively delete the installation directory, because it may contain
  unrelated user commands. Delete only installer-owned files within it.
- Do not print success after an unlink, profile update, runtime stop, actor
  deletion, or filesystem operation fails.

### Partial failure reporting

Uninstallation should attempt independent safe cleanup operations even if one
fails, then return one aggregated error. Its output should identify what remains
without exposing unrelated profile contents:

```text
Sensos was only partially uninstalled.

Remaining:
  runtime process 12345
  /Users/example/.local/bin/sensos
  managed block in /Users/example/.zshrc

Resolve the items above and run `sensos uninstall` again.
```

The exit status must be non-zero. A repeated invocation should safely continue
from the partial state and eventually succeed.

### Standalone `uninstall.sh`

The standalone script should use `set -euo pipefail`, but aggregate expected
cleanup failures so it can report all remaining targets. It should:

1. Find `sensos` on PATH or at the receipt's validated executable path.
2. Prefer running that binary's `uninstall` command.
3. If the binary cannot run, read and validate the installation receipt.
4. Stop a recorded runtime only when its PID identity can be verified as Sensos.
5. Remove receipt-owned binary and shell blocks without following symlinks.
6. Remove Sensos product directories using the same OS-native path rules.
7. Print recovery guidance when clean actor deletion was impossible.

Fallback cleanup may necessarily abandon actors rather than call their lifecycle
hooks because the executable is unavailable. Since it removes their complete
local storage afterward, it must say that it performed filesystem recovery rather
than a graceful actor shutdown.

The script cannot change the already-running parent shell. On success it should
suggest `rehash` for zsh, `hash -r` for bash, or opening a new terminal when the
old command remains cached.

### Uninstallation tests

- [ ] Normal uninstall after a CDN-style copied installation.
- [ ] Normal uninstall after `setup.sh --local` with an install path containing
  spaces.
- [ ] Recovery-script uninstall when the installed binary is missing or broken.
- [ ] Repeated uninstall after complete and partial cleanup.
- [ ] Partial runtime-stop, actor-delete, profile-write, and executable-delete
  failures return non-zero and list what remains.
- [ ] Missing receipt, missing profiles, and missing product directories.
- [ ] Multiple supported shell profiles containing managed blocks.
- [ ] Incomplete or malformed managed blocks remain untouched.
- [ ] Generic Bun and user PATH entries remain untouched.
- [ ] A `sensos` symlink is unlinked without modifying its target.
- [ ] Malicious receipt paths such as `/`, home, relative paths, and traversal
  are rejected before mutation.

## Upgrade strategy

Initially, rerunning `setup.sh` is the supported upgrade mechanism:

```sh
curl -fsSL https://sensos.sh/setup.sh | bash
```

It should replace only the executable and preserve all product data. A future
`sensos upgrade` command may reuse the same release manifest, checksum
verification, and atomic replacement rules. Do not maintain separate update
protocols for the script and CLI.

Downgrades should require an explicit version:

```sh
curl -fsSL https://sensos.sh/setup.sh | bash -s -- v0.1.0
```

Database and actor-state compatibility must be documented before claiming that
downgrades are supported.

## Release automation

A tagged release workflow should:

1. Validate that the tag matches `package.json`.
2. Install dependencies from the lockfile.
3. Run Biome, typechecking, and the full test suite.
4. Build every supported target in isolated jobs.
5. Run each target binary on a matching native runner.
6. Execute installer, first-run, resume, runtime-stop, and uninstall smoke tests.
7. Confirm no repository paths or external runtime assets are required.
8. Package licenses and third-party notices.
9. Generate and verify `checksums.txt`.
10. Publish immutable versioned artifacts.
11. Update `latest.txt` only after every artifact is available.

Do not publish `latest.txt` from an individual matrix job. It is the final commit
point for a complete release.

## Verification checklist

### Binary

- [ ] Runs on a clean machine without Bun or Node.js.
- [ ] `sensos --version` matches the release tag.
- [ ] Does not reference the repository or `node_modules`.
- [ ] Materializes matching native assets once and reuses them.
- [ ] Starts and stops the supervised runtime without orphan processes.
- [ ] Runs a test-model chat, resumes it, lists it, and deletes it.

### Installer

- [ ] Installs latest, explicit-version, and local binaries.
- [ ] Verifies SHA-256 before modifying the installed executable.
- [ ] Handles paths containing spaces.
- [ ] Is idempotent when rerun.
- [ ] Preserves a working previous version if download or verification fails.
- [ ] Adds no shell block when the install directory is already in PATH.
- [ ] Supports zsh, bash, and fish managed blocks.

### Uninstaller

- [ ] Works after CDN and `--local` installation.
- [ ] Works when files have already been partially removed.
- [ ] Removes only Sensos-owned profile blocks.
- [ ] Preserves generic Bun and user PATH configuration.
- [ ] Handles the legacy Bun-linked development installation.
- [ ] Reports partial failures with a non-zero exit code.
- [ ] Leaves no Sensos runtime, session, catalog, cache, or binary artifacts.
- [ ] Leaves no Sensos or Rivet processes or listening ports.

## Milestones

### Milestone 1: Local installer

- [ ] Add `scripts/setup.sh` with `--local`, version, and install-directory
  handling.
- [ ] Record the resolved installation location.
- [ ] Align `sensos uninstall` with copied-binary installations.
- [ ] Add isolated-home tests for shell blocks, paths, reinstall, and uninstall.
- [ ] Replace `bun link` with `--local` installation in production smoke tests.

### Milestone 2: Portable builds

- [ ] Introduce target-aware native asset manifests.
- [ ] Build macOS ARM64 and x86-64 artifacts.
- [ ] Build Linux ARM64 and x86-64 artifacts.
- [ ] Verify the binary is independent of the repository and Bun.
- [ ] Package required legal notices.

### Milestone 3: Release pipeline

- [ ] Add tagged CI builds on native runners.
- [ ] Add archive checksum generation and verification.
- [ ] Publish immutable version directories to the release CDN.
- [ ] Publish `latest.txt` only after the release is complete.
- [ ] Smoke-test public installation from the CDN.

### Milestone 4: Operational hardening

- [ ] Add signed release provenance or artifact signatures.
- [ ] Add installation and upgrade rollback coverage.
- [ ] Define compatibility policy for catalog, actor data, and downgrades.
- [ ] Add `sensos upgrade` by reusing the installer release protocol.
- [ ] Evaluate Windows only after its runtime dependencies are supported.
