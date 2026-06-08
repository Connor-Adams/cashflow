# Cashflow conventions (canonical)

> This file is the single source of truth for how to work in this repo. Skills and
> hooks defer to it. If a global skill (cashflow-issue-worker / cashflow-tackle /
> cashflow-product-design) contradicts this file, **this file wins** — it versions
> with the code; the skills do not.

## Workspaces (yarn-1 monorepo, run everything from repo root)

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

- A fresh worktree may have **no `node_modules`** (or only a partial one). Consequences:
  - `yarn install` / `yarn setup` fails under a worktree (vite-link error). Install from
    the **main checkout** (`/Users/connoradams/Developer/cashflow`).
  - `git commit` fails at husky→lint-staged (code 127) because the binary isn't on PATH.
    Fix: `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit …`.
  - To run eslint/tsc/tsx in a worktree, prefix the same PATH or call the binary from the
    main checkout's `node_modules/.bin/`.
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
