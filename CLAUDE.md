# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Cashflow is a local-first personal & partner expense tracker: import card CSVs and
PDF statements, categorize and split transactions, attach receipts, track
investments, and roll spend into per-currency summaries. Yarn 4 (Berry) workspace
monorepo (`backend`, `frontend`, `shared`); `packageManager: yarn@4.17.0` is pinned
in `package.json` and run via Corepack.

## Primitives spine (READ BEFORE ADDING ANY MODEL, ROUTE, OR PAGE)

Cashflow is built on **13 canonical primitives**. A primitive is a distinct
*status machine + noun*, not a data shape. Full spec:
`docs/superpowers/specs/2026-05-30-cashflow-primitives-design.md` (it carries the
table mapping each primitive to the physical models it folds).

The 13: **Transaction, Expectation, Account, Holding, Principal, Counterparty,
Scenario, Budget, Goal, Proposal, Observation, Document, Period.**

### The build rule

Before creating any new model, route, or page, answer:

> **Does this introduce a new status machine, or a new variant/view of an
> existing primitive?**

- **New variant** → add a `type`/`kind` field to the existing primitive.
- **New view** → add a query/derivation. No new table.
- **New behavior** → add a field or computed property to the owning primitive.
- **New status machine** → a new primitive. RARE. You must name its lifecycle and
  show it is not an existing machine wearing a new shape. Flag this explicitly in
  the PR — it is a spine change, not a feature.
- **Mirrors an existing machine** → STOP. It is a fork. Fold via a discriminator
  field instead.

Three checks, in order:
1. Which of the 13 does this extend? Exactly one → extend it. None → new primitive
   (justify) or the requirement is confused. Multiple → you are adding a
   relation/view, not a thing.
2. Persistent state or derived? Derived → no table, add computation. Persistent →
   which primitive owns it? Add a column or child table.
3. Does the shape mirror an existing primitive under a new name? Yes → fold.

Do not fork same-machine objects; do not merge different-machine objects.

## Commands

Run everything from the **repo root** — workspaces hoist to the root.
Never install or run from a sub-directory; if stray `backend/node_modules` or
`frontend/node_modules` exist, delete them and reinstall at root.

> **Worktrees (`.claude/worktrees/<name>`):** under Yarn 4 each worktree gets its
> **own** real `node_modules` — run `corepack yarn install` **inside the worktree**
> (the worktree root *is* its install root). Do **not** install from the main
> checkout to "fix" a worktree: that rewrites the main checkout's `yarn.lock` and
> cross-contaminates whatever branch it's sitting on. A freshly created worktree
> simply has no `node_modules` until you install in it. See the worktree gotchas in
> `.claude/conventions.md` for the husky/`.yarn-state.yml` commit wrinkle.

| Task | Command |
|---|---|
| Install + migrate | `yarn setup` |
| Dev (API + Vite together) | `yarn dev` — API on `:3001`, UI on `:5173` (proxies `/api`) |
| Everything CI runs | `yarn ci` — typecheck, all tests, both production builds |
| All tests | `yarn test` |
| Backend typecheck | `yarn workspace cashflow-backend run typecheck` |
| Backend / frontend lint | `yarn workspace cashflow-backend run lint` · `yarn workspace frontend run lint` |
| Migrate / undo | `yarn db:migrate` · `yarn workspace cashflow-backend run db:migrate:undo` |
| Code health | `yarn audit:code` (fallow + jscpd); also `yarn deadcode`, `yarn health`, `yarn dupes` |

### Running a single test

Backend tests use **`node:test` via `tsx`** (not vitest/jest); frontend uses **vitest**.

- Backend, one file: `cd backend && yarn tsx --import ./test/setup.ts --test src/fx/toCad.test.ts`
- Backend, filter by name: append `--test-name-pattern '<regex>'`
- Frontend, one file: `yarn workspace frontend run test ReceiptsPage`
- Frontend, filter by name: `yarn workspace frontend run test -- -t 'renders empty state'`

> **Unit tests are colocated** — `foo.test.ts` beside `foo.ts` under `backend/src/`.
> `backend/scripts/run-unit-tests.sh` (via `backend/test/list-unit-tests.mjs`)
> recursively discovers every `backend/src/**/*.test.ts`, so a new colocated test
> runs automatically — no glob to maintain. The runner exits non-zero if zero
> files are discovered (guards a silent empty run); `test:coverage` keeps the
> two-phase c8 accumulation (unit, then integration).
> `backend/.c8rc.json` sets `merge-async: true` so c8 merges the ~1500
> `coverage/tmp` fragments incrementally; the default sync merge loads them all
> at once and OOM-aborts (exit 134, V8 `JsonParser` heap abort) once the
> accumulated fragments exceed the merge process's old-space.
>
> Two carve-outs: **integration** tests stay in `backend/test/integration/`
> (cross-cutting, Postgres), and **migration** tests live in
> `backend/src/migrations/__tests__/` — NOT directly in `src/migrations/`, because
> `sequelize-cli` scans that dir for migrations and would try to load a `.test.ts`
> as one (it doesn't recurse into the subdir).

- **Unit** tests get a per-process SQLite temp DB (`backend/test/setup.ts`, keyed
  by PID — parallel workers don't collide). No external services needed.
- **Integration** tests (`backend/test/integration/*.test.ts`, via
  `...run test:integration`) need **Postgres**; set `TEST_DATABASE_URL`. CI runs
  them in a dedicated job with a Postgres service.

## Architecture

Three workspaces: **`backend`** (Express + Sequelize API), **`frontend`** (Vite +
React 19), **`shared`** — a single file, `shared/api-types.ts`, the API DTO
contract imported by both sides as `@cashflow/shared`. Also: `infra/` (local
observability stack), `docs/` (specs under `docs/superpowers/`, ADRs under
`docs/adr/`), and root `test/*.test.cjs` (workflow/release tests, `yarn test:workflows`).

### Backend (`backend/src/`)
- **Router mounts live in a declarative registry**, `backend/src/routeRegistry.ts`
  — ordered `preAuthRoutes`, the `requireAuth` boundary, then `gatedRoutes`;
  `app.ts` calls `mountRoutes(app)` and owns only the surrounding middleware
  pipeline + terminal error handlers. **Mount order is still load-bearing**
  (specific before catch-all `/api`; capture CORS before the global `cors()`;
  folded endpoints return `410 Gone`, e.g. `/api/tax/{personal,corp}-scenarios` →
  `/api/tax/scenarios/:kind`) — but it is now data with a `why` per entry, and
  `backend/test/appRouteOrder.test.ts` locks the invariants so a bad reorder or a
  dropped fold-stub fails CI.
- **~90 Sequelize models** in `models/` are the *physical* tables; the **13
  primitives** are the *conceptual* spine many of them fold into. Consult the
  spine table before adding a model.
- **Feature modules** are the top-level dirs under `src/` (`ai/`, `amazon/`,
  `import/`, `portfolio/`, `tax/`, `forecast/`, `budgets/`, `insights/`,
  `scenarios/`, …): domain logic paired with a `routes/*.ts` router.
- **Migrations** are JavaScript in `backend/src/migrations/` (Sequelize CLI),
  named `YYYYMMDD...-slug.js`.
- **Auth** is cookie-session and **household-scoped**: `attachAuth` then a global
  `requireAuth` at `/api`; request context (`withContext`) carries
  `userId`/`householdId`/`role` for logging. Health, config, auth, capture,
  reporting (`/api/v1`), and audit routes mount *before* `requireAuth`.
- **DB is dual-dialect**: SQLite by default (file `backend/data/cashflow.sqlite`),
  Postgres when `DATABASE_URL` / `TEST_DATABASE_URL` is set. Write Sequelize that
  runs on both. Multi-currency throughout (`DEFAULT_CURRENCY=CAD`, `FxRate` table).
- **Observability**: pino logs + OpenTelemetry traces/metrics over OTLP. `infra/`
  brings up Grafana/Loki/Tempo/Prometheus locally via docker-compose; see
  `docs/observability.md`.

### Frontend (`frontend/src/`)
React 19 + react-router-dom v7, Tailwind v4 (with Radix primitives, lucide icons,
recharts). Pages in `pages/`, the shared API client in `lib/api.ts`, types from
`@cashflow/shared`. `yarn workspace frontend run build` also emits the Amazon and
Apple **bookmarklets** (`vite.bookmarklets.config.ts`) that POST receipts/orders to
`/api/capture`. Prefer Tailwind utilities over raw CSS in `App.css`.

### Deploy
Image-based: on merge to `main`, CI builds and pushes `backend`/`frontend` images
to GHCR — **`main` does not auto-deploy**. Publishing a GitHub Release re-tags the
images `:production` and fires Railway redeploys. Full pipeline, version-bump
rules, and rollback steps are in `README.md`.
