# Cashflow conventions (canonical)

> This file is the single source of truth for how to work in this repo. Skills and
> hooks defer to it. If a global skill (cashflow-issue-worker / cashflow-tackle /
> cashflow-product-design) contradicts this file, **this file wins** — it versions
> with the code; the skills do not.

## Workspaces (Yarn 4 Berry monorepo, run everything from repo root)

`packageManager: yarn@4.17.0` is pinned in `package.json`; invoke via Corepack
(`corepack yarn …`). `.yarnrc.yml` sets `nodeLinker: node-modules` (a real
`node_modules`, **not** PnP) + `nmMode: hardlinks-local`; the lockfile is Berry
format (`__metadata: version 10`).

| Workspace | yarn name | Notes |
|---|---|---|
| backend | `cashflow-backend` | NOT `backend`. Express + Sequelize. |
| frontend | `frontend` | Vite + React 19. **No `typecheck` script** — use `tsc -b`. |
| shared | `shared` | One file `shared/api-types.ts`, imported as `@cashflow/shared`. |

## Tests

- Backend: **`node:test` via `tsx`** (no vitest, no `--run` flag). Tests are
  **auto-discovered**: `backend/scripts/run-unit-tests.sh` → `backend/test/list-unit-tests.mjs`
  finds every `backend/test/**/*.test.ts` **except** `test/integration/**`.
  - Backend tests live in **`backend/test/`** (flat tree), NOT `backend/src/**/__tests__/`.
  - All backend unit: `yarn workspace cashflow-backend run test`
  - One file: `cd backend && yarn tsx --import ./test/setup.ts --test test/<file>.test.ts`
  - Filter by name: append `--test-name-pattern '<regex>'`
  - Integration (needs Postgres, `TEST_DATABASE_URL`): `yarn workspace cashflow-backend run test:integration`
- Frontend: **vitest**. One file: `yarn workspace frontend run test <Name>`.
- Everything: `yarn test` (backend unit + backend integration + frontend).

## Verify suite (before claiming done / opening a PR)

Prefer the full gate: **`yarn ci`** (= test:workflows + backend typecheck + backend
unit + backend integration + backend build + frontend test + frontend build).

Partial / faster:
- Backend typecheck: `yarn workspace cashflow-backend run typecheck` (`tsc --noEmit`)
- Frontend typecheck: `yarn workspace frontend run tsc -b` (no `typecheck` script)
- Backend lint: `yarn workspace cashflow-backend run lint` (`eslint src --ext .ts`)
- Frontend lint: `yarn workspace frontend run lint` (`eslint .`)
- Migration round-trip: `yarn workspace cashflow-backend run db:migrate` then
  `yarn workspace cashflow-backend run db:migrate:undo` then re-migrate.
  (The undo script is **`db:migrate:undo`** — there is no `db:rollback`.)

## Worktree gotchas (.claude/worktrees/<name>)

Under Yarn 4 each worktree gets its **own** real `node_modules` — the worktree root
*is* its install root.

- A freshly created worktree has **no `node_modules`** until you install in it. The fix
  is to **install inside the worktree**: `corepack yarn install` (verified — completes in
  a few seconds and produces a real `node_modules/` with `.yarn-state.yml` and a local
  `node_modules/.bin/`). The old Yarn-1 advice — "`yarn install`/`yarn setup` fails under
  a worktree (vite-link error), install from the main checkout" — is **wrong under
  Yarn 4**. Do **not** `yarn install` from the main checkout to "fix" a worktree: it
  rewrites the main checkout's `yarn.lock` and cross-contaminates whatever branch it is
  sitting on.
- Once the worktree has its own `node_modules`, `git commit` works normally — eslint /
  tsc / tsx and the husky pre-commit hook all resolve from the worktree's local
  `node_modules/.bin/`. The hook script `cd`s to `git rev-parse --show-toplevel` (the
  worktree root), so it runs against the worktree's staged files.
- **Husky `.yarn-state.yml` wrinkle (don't reach for `--no-verify`):** the pre-commit
  hook runs `yarn lint-staged`. If the worktree has **no** own `node_modules` and falls
  back to a main checkout that is still on an old **Yarn-1** branch, Corepack's Yarn 4
  runs against a Yarn-1 `node_modules` and fails with
  `Couldn't find the node_modules state file - findPackageLocation` (the node-modules
  linker needs `node_modules/.yarn-state.yml`, which a Yarn-1 tree lacks). The real fix
  is `corepack yarn install` **in the worktree** (gives it the state file). Escape hatch
  if you genuinely cannot install: front a **classic Yarn** on PATH so the hook still
  RUNS (never `--no-verify`, never `--amend` after a hook failure) —
  e.g. a `/tmp/yarn1shim/yarn` that `exec corepack yarn@1.22.22 "$@"`, then
  `PATH=/tmp/yarn1shim:$PATH git commit …`. `lint-staged.config.cjs` only matches
  `frontend/**/*.{ts,tsx}`, so doc/infra/backend-only commits are a no-op anyway.
- An **absolute** `/Users/connoradams/Developer/cashflow/{backend,frontend,shared}/…`
  path used while inside a worktree points at the **main checkout, not your branch**.

## Primitives spine (READ before adding any model / route / page)

Full rule: `docs/superpowers/specs/2026-05-30-cashflow-primitives-design.md`.

The 13: **Transaction, Expectation, Account, Holding, Principal, Counterparty,
Scenario, Budget, Goal, Proposal, Observation, Document, Period.**

Before a new model/route/page, answer 3 checks:
1. Which of the 13 does this extend? Exactly one → extend it (type/kind field or column).
   None → new primitive (RARE — justify in PR). Multiple → a relation/view, not a thing.
2. Persistent or derived? Derived → no table, add a query. Persistent → which primitive owns it?
3. Shape mirrors an existing primitive under a new name? → STOP, fold via a discriminator.

Mount order is load-bearing and locked by `backend/test/appRouteOrder.test.ts`; routes
mount via the declarative `backend/src/routeRegistry.ts`.

## Commit / PR

- **Sole author** — never add `Co-Authored-By` trailers.
- Never `--no-verify`; never `--amend` after a hook failure (make a new commit).
- Never commit `*.sqlite` / `*.sqlite-journal` / `node_modules/` / `backend/data/`.
- Merge style: **auto-merge with a merge commit, never squash**
  (`gh pr merge <N> --auto --merge --delete-branch`). Flip `allow_auto_merge` if rejected.

## GitHub Project board (canonical IDs)

- Board: https://github.com/users/Connor-Adams/projects/1 (user-scoped, owner `Connor-Adams`)
- Project node ID: `PVT_kwHOAVVoss4BY3pN`

| Field | Field ID | Options (option ID) |
|---|---|---|
| Pipeline | `PVTSSF_lAHOAVVoss4BY3pNzhT6VwQ` | Triage `2abd1768` · Backlog `6ba82814` · Up Next `2f793326` · In Flight `affc6f81` · Shipped `e3cf823b` |
| Phase | `PVTSSF_lAHOAVVoss4BY3pNzhT6Vxk` | Foundation · Surface · Polish |
| Epic | `PVTSSF_lAHOAVVoss4BY3pNzhT6VzQ` | 14 clusters + (none) |
| Priority | `PVTSSF_lAHOAVVoss4BY3pNzhT6Xx0` | P0 `30b35486` · P1 `341906c0` · P2 `53db02f4` |

Dependencies use GitHub **Sub-issues** (parent → tracked sub-issues); a sub-issue is
blocked iff its parent is open. Project Pipeline is the canonical pick order; body
`Depends on X` lines are legacy fallback only.
