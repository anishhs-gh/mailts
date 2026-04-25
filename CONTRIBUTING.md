# Contributing to mailts

Complete guide for contributors and maintainers — from first clone through publishing a signed release.

---

## Table of Contents

1. [Repository Layout](#1-repository-layout)
2. [Prerequisites](#2-prerequisites)
3. [Local Setup](#3-local-setup)
4. [Development Workflow](#4-development-workflow)
5. [TypeScript Standards](#5-typescript-standards)
6. [Testing Requirements](#6-testing-requirements)
7. [Pre-Push Checklist](#7-pre-push-checklist)
8. [Branch & Commit Conventions](#8-branch--commit-conventions)
9. [Pull Request Process](#9-pull-request-process)
10. [Versioning](#10-versioning)
11. [Release & Deployment](#11-release--deployment)
12. [Dependency Rules](#12-dependency-rules)
13. [Security](#13-security)

---

## 1. Repository Layout

```
mailts/                        ← root package (npm: mailts)
├── src/                       ← core SMTP/IMAP library source
├── tests/                     ← root unit tests (vitest)
├── packages/
│   ├── cli/                   ← npm: @mailts/cli
│   ├── trap/                  ← npm: @mailts/trap
│   └── testing/               ← npm: @mailts/testing
├── developer-reference/       ← internal docs (not shipped)
├── .github/workflows/         ← CI + per-package release workflows
├── tsconfig.base.json         ← shared TS config (all packages extend this)
└── package.json               ← workspace root, declares workspaces: ["packages/*"]
```

**Publish dependency order:**

```
mailts  →  @mailts/trap   →  @mailts/testing
       →  @mailts/cli
```

`@mailts/trap` and `@mailts/cli` can be published in parallel after `mailts`.  
`@mailts/testing` depends on both `mailts` (peer) and `@mailts/trap` (dependency), so it ships last.

---

## 2. Prerequisites

| Tool | Minimum | Notes |
|---|---|---|
| Node.js | 18.x | 20.x recommended |
| npm | 9.x | ships with Node 18+ |
| Git | 2.x | — |

No global installs required beyond Node/npm.

---

## 3. Local Setup

```bash
git clone https://github.com/anishhs-gh/mailts.git
cd mailts
npm install          # installs root + all workspace packages via npm workspaces
```

`npm install` from the root links `packages/cli`, `packages/trap`, and `packages/testing` into `node_modules` so local `file:` references resolve correctly. **Never run `npm install` inside a package subdirectory** — always from the root.

### Verify setup

```bash
npm run typecheck    # typechecks root + all workspaces
npm test             # runs root tests + all workspace tests
npm run build        # builds root + all workspaces
```

All three must pass cleanly before you start working.

---

## 4. Development Workflow

### Working on the root `mailts` package

```bash
# Watch mode — rebuilds on save
npm run dev

# Run only core tests (fast, skip workspaces)
npm run test:core

# Typecheck only root
npm run typecheck --workspace=.
```

### Working on a workspace package

```bash
# Example: working on @mailts/trap
npm run dev --workspace=packages/trap
npm test --workspace=packages/trap
npm run typecheck --workspace=packages/trap
```

### How local cross-package imports work

Each workspace `package.json` has `file:` references in `devDependencies`:

```json
"devDependencies": {
  "mailts": "file:../..",
  "@mailts/trap": "file:../trap"
}
```

These are **dev-only** for local type resolution and testing. They are **not published** — the release workflow rewrites them to real semver ranges before `npm publish`. Do not change them to `*` or semver ranges; they would break local development.

---

## 5. TypeScript Standards

All packages extend `tsconfig.base.json` at the repo root. The following compiler flags are non-negotiable:

| Flag | Value | Why |
|---|---|---|
| `strict` | `true` | catches null dereferences, implicit any |
| `noUncheckedIndexedAccess` | `true` | array/object access returns `T \| undefined` |
| `noImplicitReturns` | `true` | all code paths must return |
| `useUnknownInCatchVariables` | `true` | `catch (e)` is `unknown`, not `any` |
| `isolatedModules` | `true` | required for tsup/esbuild compatibility |

**Rules:**

- No `as any`. Use type narrowing or `as unknown as T` only when unavoidable, with a comment explaining why.
- No `// @ts-ignore` or `// @ts-expect-error` without a comment on the next line explaining the suppression.
- All exported functions and types must have explicit return types.
- Prefer `unknown` over `any` for external input boundaries (HTTP bodies, config files, SMTP data).
- Imports must use `.js` extensions (e.g., `import { foo } from './foo.js'`) — required for ESM interop.

---

## 6. Testing Requirements

### Coverage expectations

| Area | Requirement |
|---|---|
| Core library (`src/`) | All public API methods, error paths, edge cases |
| `@mailts/trap` | SMTP capture, MIME parsing, HTTP API endpoints, SSE |
| `@mailts/cli` | Argument parsing, command dispatch (unit); SMTP integration (integration) |
| `@mailts/testing` | `useTrapServer()` lifecycle, `waitForMessage()` polling and timeout |

**Unit tests** live in `tests/` relative to the package root.  
**No test file should be skipped or pending at the time of a PR merge.**

### Running tests

```bash
# All tests (root + workspaces)
npm test

# Root package only
npm run test:core

# Single workspace
npm test --workspace=packages/trap

# Coverage report (root only)
npm run test:coverage
```

### Test conventions

- Use `describe` blocks to group related cases; name them after the unit being tested.
- Prefer real in-process servers over mocks for network-touching code (see `tests/unit/transports/HttpClient.test.ts` for the pattern).
- Never mock the SMTP/IMAP protocol layer — integration tests must use `TrapServer` or a real SMTP server.
- `@mailts/testing` tests **must** have `globals: true` in `vitest.config.ts` — `useTrapServer()` relies on `beforeAll`/`afterAll` globals.
- Assertion style: use `expect(x).toBe(y)` for primitives, `toEqual` for objects, `toMatchObject` for partial matching.
- Test file naming: `<Unit>.test.ts`. One file per unit (class or module).

### Vitest config requirement for `@mailts/testing`

```ts
// packages/testing/vitest.config.ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/**/*.test.ts'], globals: true } });
```

`globals: true` is mandatory — without it, `useTrapServer()` silently registers no lifecycle hooks and tests leak server state.

---

## 7. Pre-Push Checklist

Run this before every `git push`, without exception:

```bash
npm run typecheck    # zero TS errors across all packages
npm test             # zero failing tests across all packages
npm run build        # all dist/ artifacts produced cleanly
```

Additionally verify:

- [ ] No `console.log` left in library code (use the `Logger` from `mailts/logger`)
- [ ] No hardcoded credentials, tokens, or secrets anywhere in source or tests
- [ ] No `file:` paths added as `dependencies` (only allowed in `devDependencies`)
- [ ] No new `peerDependencies` added without updating `peerDependenciesMeta`
- [ ] `dist/` directories are in `.gitignore` and not committed
- [ ] New public API surfaces have corresponding tests
- [ ] `package.json` version in the affected package is bumped if this is a release PR

---

## 8. Branch & Commit Conventions

### Branch naming

```
feat/<short-description>        new feature
fix/<short-description>         bug fix
chore/<short-description>       tooling, deps, CI
docs/<short-description>        documentation only
test/<short-description>        tests only
```

### Commit messages (Conventional Commits)

```
<type>(<scope>): <short description>

[optional body — the WHY, not the WHAT]
```

| Type | When |
|---|---|
| `feat` | adds user-visible functionality |
| `fix` | corrects a bug |
| `chore` | tooling, deps, CI changes |
| `docs` | documentation only |
| `test` | adds or fixes tests without changing logic |
| `refactor` | restructures code without changing behaviour |
| `perf` | measurable performance improvement |

Scope is the package name without the `@mailts/` prefix: `core`, `trap`, `cli`, `testing`, `ci`.

**Examples:**

```
feat(trap): add SSE endpoint for real-time message push
fix(core): handle SMTP 421 temporary rejection in retry loop
chore(ci): add workspace typecheck step to ci.yml
test(testing): cover waitForMessage timeout path
```

Breaking changes must include `BREAKING CHANGE:` in the commit body.

---

## 9. Pull Request Process

1. **One concern per PR.** A feature PR should not also refactor unrelated code.
2. Target `main`. No direct pushes to `main` — all changes go through PRs.
3. Every PR must:
   - Pass CI (typecheck + lint + test + build across Node 18 and 20)
   - Have a description explaining *why* the change is needed
   - Reference any related issue with `Closes #<n>`
4. For breaking changes: bump the major version in `package.json` and document migration steps in the PR description.
5. For new packages: the PR must include `package.json`, `tsconfig.json`, `tsup.config.ts`, a README, at least one test file, and a corresponding release workflow in `.github/workflows/`.

---

## 10. Versioning

All packages use [Semantic Versioning](https://semver.org):

| Change | Version bump |
|---|---|
| Bug fix, internal refactor | patch (`0.1.0 → 0.1.1`) |
| New feature, new export, new option | minor (`0.1.0 → 0.2.0`) |
| Breaking API change, removed export | major (`0.1.0 → 1.0.0`) |

Version bumps are **manual** — edit `package.json` in the PR that introduces the change. Do not rely on automated tooling to bump versions.

### Cross-package version coupling

- `@mailts/cli` and `@mailts/trap` declare `mailts` as a `peerDependency` with range `>=X.Y.0 <(X+1).0.0`.
- `@mailts/testing` declares both `mailts` and `@mailts/trap` as peers with the same pattern.
- When `mailts` ships a **minor** with new API that `@mailts/cli` depends on, widen the peer range floor: `>=0.2.0 <2.0.0`. Bump `@mailts/cli` minor too.
- When `mailts` ships a **major**, all packages must release a new major that widens the peer upper bound.

---

## 11. Release & Deployment

Publishing is **always triggered by a Git tag**, never by a CI commit. There is no automated versioning bot. You push the tag; GitHub Actions builds, signs, and publishes.

### One-time setup (per repository)

1. Add `NPM_TOKEN` to repository secrets (Settings → Secrets → Actions).  
   The token must have `Automation` scope and publish access to the `mailts` npm org.
2. Ensure the repository has **Actions permissions** to create releases (`Settings → Actions → Workflow permissions → Read and write`).

### Release workflow per package

Each package has its own workflow file triggered by a specific tag pattern:

| Package | Workflow file | Tag pattern | Example tag |
|---|---|---|---|
| `mailts` | `release.yml` | `mailts@*` | `mailts@1.2.0` |
| `@mailts/trap` | `release-trap.yml` | `@mailts/trap@*` | `@mailts/trap@1.0.1` |
| `@mailts/cli` | `release-cli.yml` | `@mailts/cli@*` | `@mailts/cli@1.0.1` |
| `@mailts/testing` | `release-testing.yml` | `@mailts/testing@*` | `@mailts/testing@1.0.1` |

### Step-by-step: releasing a package

**Step 1 — bump the version**

Edit `package.json` of the target package, commit, and merge to `main`:

```bash
# Example: releasing mailts 1.2.0
# Edit package.json: "version": "1.2.0"
git add package.json
git commit -m "chore(core): bump version to 1.2.0"
git push origin main
```

Wait for CI to pass on `main` before tagging.

**Step 2 — push the tag**

```bash
git tag mailts@1.2.0
git push origin mailts@1.2.0
```

This triggers `release.yml`. The workflow will:

1. `npm ci` — install full workspace
2. Typecheck → Test → Build the package
3. Verify the tag version matches `package.json` version (fails if mismatched)
4. Create a GitHub Release with auto-generated notes
5. `npm publish --provenance --access public` — signed with OIDC

**Step 3 — verify the publish**

Check `https://www.npmjs.com/package/mailts` and confirm:
- Version appears under "Versions"
- Provenance badge is shown (the shield icon) — this means the release was signed

### Releasing workspace packages

Follow the **same steps** but use the package-specific tag. In addition:

- For `@mailts/trap` and `@mailts/cli`: `mailts` must already be published at the version declared in their `peerDependencies` range.
- For `@mailts/testing`: both `mailts` and `@mailts/trap` must already be published.

```bash
# Publishing @mailts/trap 1.0.1 after mailts 1.0.0 is already on npm
git tag @mailts/trap@1.0.1
git push origin @mailts/trap@1.0.1
```

The release workflow automatically rewrites `file:../..` → real semver in the published `package.json` before `npm publish`. You never need to edit `devDependencies` manually for publishing.

### What the tag version guard does

Each workflow contains:

```bash
PKG_VERSION=$(node -p "require('./package.json').version")
TAG_VERSION="${GITHUB_REF_NAME#mailts@}"
if [ "$PKG_VERSION" != "$TAG_VERSION" ]; then exit 1; fi
```

If the tag is `mailts@1.2.0` but `package.json` says `1.1.0`, the workflow fails immediately. This prevents publishing the wrong version. Fix: update `package.json`, merge, re-tag.

### Rollback / yanking a release

npm does not support deleting published versions. To deprecate a bad release:

```bash
npm deprecate mailts@1.2.0 "critical bug — use 1.2.1"
```

Then publish a patch fix immediately.

### What NOT to do

- Do not run `npm publish` locally — always let GitHub Actions publish. Local publishes lose provenance signing.
- Do not tag before the version bump is merged to `main` — the workflow checks out `main`'s code.
- Do not force-push tags. If a tag was pushed in error, delete it (`git push --delete origin mailts@1.2.0`) and re-tag after fixing.
- Do not amend commits that have already been tagged.

---

## 12. Dependency Rules

### Root `mailts` package

- **No runtime `dependencies`.** Everything is in `devDependencies`. The library uses only Node.js built-ins at runtime.
- Built-in modules used: `tls`, `net`, `crypto`, `stream`, `buffer`, `dns`, `fs`, `path`, `http`, `events`.

### `@mailts/trap`

- `peerDependencies`: `mailts >=0.1.0 <2.0.0` (required, not optional)
- `devDependencies` (local dev only): `mailts: file:../..`
- No other runtime dependencies — uses only Node built-ins beyond `mailts`

### `@mailts/cli`

- `peerDependencies`: `mailts >=0.1.0 <2.0.0` (required)
- `devDependencies` (local dev only): `mailts: file:../..`
- No bundled `dependencies`

### `@mailts/testing`

- `dependencies`: `@mailts/trap >=0.1.0 <2.0.0` (bundled runtime dep — users install this for test helpers)
- `peerDependencies`: `mailts >=0.1.0 <2.0.0` (required)
- `devDependencies` (local dev only): `mailts: file:../..`, `@mailts/trap: file:../trap`

### General rules

- Never add a `dependency` that can be expressed as a peer — this forces a single version on all consumers.
- Never add a `file:` reference to `dependencies` — only `devDependencies`. `file:` paths don't resolve for npm consumers.
- Before adding any new dependency: check its transitive dep count, last publish date, TypeScript support, and license. Prefer packages with zero or minimal transitive deps.
- All `devDependencies` must be pinned to a caret range (`^x.y.z`) — no `*` or unranged versions.

---

## 13. Security

- **No secrets in source.** Use environment variables. Never log tokens, passwords, or session keys, even at debug level.
- **Input validation at all boundaries.** SMTP commands, HTTP request bodies, config file values, and CLI arguments must all be validated before use.
- **No `eval`, `Function()`, or dynamic `require()`** with user-controlled input.
- Run `npm audit --audit-level=high` before every PR merge. CI enforces this — a high-severity audit failure blocks merge.
- If a vulnerability is found in a dependency that cannot be patched immediately, open a security issue and add a `npm audit` exemption comment explaining the risk and timeline.
- For security vulnerabilities in `mailts` itself: do not open a public issue. Email `anishsh701@gmail.com` directly with details.

---

## Quick Reference

```bash
# Setup
npm install

# Daily development
npm run dev                              # watch root
npm run dev --workspace=packages/trap   # watch a package

# Validate before push
npm run typecheck && npm test && npm run build

# Release (example: mailts 1.2.0)
# 1. Edit package.json version → commit → merge to main
# 2. git tag mailts@1.2.0 && git push origin mailts@1.2.0
# 3. Watch https://github.com/anishhs-gh/mailts/actions
# 4. Verify on npmjs.com/package/mailts
```
