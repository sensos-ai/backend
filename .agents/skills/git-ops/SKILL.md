---
name: git-ops
description: Branch, commit, and PR-title conventions — the shared type-prefix vocabulary, conventional commit format and cadence, and stacked-PR/worktree references. Use when naming a branch, writing a commit message, titling a PR, or unsure which type prefix applies.
---

# git — branch & commit conventions

One vocabulary of **type prefixes** drives both branch names and commit subjects. Learn the table once; everything else derives from it.

## Type prefixes

| Prefix | Use when | Commit example | Branch example |
|--------|----------|----------------|----------------|
| `feat` | Adding new functionality | `feat: implemented stripe checkout` | `feat/stripe-billing` |
| `fix` | Fixing broken behavior | `fix: handle empty plan list` | `fix/empty-plan-crash` |
| `refactor` | Improving code without changing behavior | `refactor: extract session cache` | `refactor/session-cache` |
| `docs` | Docs, guides, comments | `docs: updated readme` | `docs/ai-skills` |
| `chore` | Maintenance, deps, tooling, config | `chore: bump biome to 1.9` | `chore/dep-bumps` |
| `test` | Adding or fixing tests | `test: cover webhook retries` | `test/webhook-retries` |
| `perf` | Performance improvements | `perf: memoize org lookup` | `perf/org-lookup` |
| `build` | Build system, bundling | `build: split vendor chunks` | `build/vendor-chunks` |
| `ci` | CI pipelines and workflows | `ci: cache bun installs` | `ci/cache-installs` |
| `style` | Formatting only, no logic change | `style: apply formatter` | `style/format-pass` |

## Branch naming

Format: **`<type>/<kebab-case-slug>`**

```
docs/ai-skills
feat/stripe-billing
fix/oauth-callback-loop
```

- Slug is short, kebab-case, and describes the unit of work — don't repeat the type in the slug (`feat/feat-billing` ❌).

## Conventional commits

Format: **`<type>: <subject>`** — one line, imperative-ish, lowercase subject.

In monorepo:
Format: **`<type>(<scope>)?: <subject>`** — include scope / workspace / domain.

```
feat(backend): implemented stripe checkout
docs: updated readme
chore: bump turbo to 2.4
fix(web)!: drop legacy session cookie   # `!` marks a breaking change
```

Rules (hook-enforced — fix the message rather than fighting the hook):

- **Single line only.** No body, no heredoc.
- **No `Co-Authored-By` trailers.**
- Scope is optional; In a monorepo, use the workspace/package touched (`web`, `backend`, `core`).

## Commit cadence

**An initial commit as soon as the first unit of work exists, then one commit per unit as each
lands.** Not an empty scaffold commit at the start, and not one batched commit at the end.

A **unit** is a vertical slice — a narrow but complete path through every layer, which works on its own. That definition is what makes this cadence natural instead of clerical: finish a slice and the commit already describes itself. If committing feels like an interruption, the units are wrong, not the rule. Full definition, and the expand–contract exception for wide refactors: See [references/slice.md](references/slice.md).

- **Never carry more than one unit of uncommitted work.** A diff spanning several logical changes
  means a commit was already owed.
- Don't batch unrelated changes into one commit.

- **Push the branch early** (`git push -u origin <branch>`) — that's what makes work visible.
  Publishing a branch and opening a PR are separate decisions.
- Holds whether the work is yours or a delegate's, and whether or not a PR is ever opened.
