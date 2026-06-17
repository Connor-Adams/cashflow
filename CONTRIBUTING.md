# Contributing

## Prerequisites

- Node.js 20+ (CI uses Node 22)
- [Yarn Classic](https://classic.yarnpkg.com/) v1 (`yarn` at the repo root)

## Install

From the repository root:

```bash
yarn install
```

Workspaces: `backend` (API), `frontend` (Vite + React), `shared` (shared TypeScript types).

## Database

```bash
yarn db:migrate
```

SQLite file defaults to `backend/data/cashflow.sqlite` (see `backend/.env.example`).

## Run the app

API + Vite together:

```bash
yarn dev
```

- API: `http://localhost:3001`
- UI: `http://localhost:5173` (proxies `/api` to the API)

### Run workspaces separately

Backend only:

```bash
yarn workspace cashflow-backend run dev
```

Frontend only (API must already be on port 3001):

```bash
yarn workspace frontend run dev
```

## Checks (same as CI)

```bash
yarn ci
```

Runs backend `typecheck`, unit tests, integration tests, backend `build`, frontend `vitest`, and frontend production `build`.

Individual steps:

```bash
yarn workspace cashflow-backend run typecheck
yarn workspace cashflow-backend run test
yarn workspace cashflow-backend run test:integration
yarn workspace cashflow-backend run build
yarn workspace frontend run test
yarn workspace frontend run build
```

## Code health: dead code, complexity & duplication

[**fallow**](https://github.com/fallow-rs/fallow) (`.fallowrc.json`) is the single static-analysis engine. It reports dead code (unused files/exports/types/deps, circular deps), function complexity / CRAP scores, and duplication. [**jscpd**](https://github.com/kucherenko/jscpd) (`.jscpd.json`) is kept alongside purely for its browsable HTML duplication report.

The CI `code-audit` job **posts a sticky pull-request comment** — a whole-repo health snapshot (dead code + complexity from fallow, duplication from jscpd) updated in place on each push — and then **enforces a baseline ratchet** (see below). The separate `fallow.yml` workflow adds **inline review comments** on changed lines; its own summary comment is disabled (`comment: false`) in favour of the rendered one.

```bash
yarn audit:code   # fallow audit (changed files) + jscpd
yarn deadcode     # fallow dead-code — unused files, exports, types, deps
yarn health       # fallow health — complexity / CRAP / maintainability
yarn dupes        # jscpd — writes reports/jscpd/html/
```

- The PR comment is rendered by `scripts/audit-summary.cjs` from the JSON reports under `reports/`.
- To keep a knowingly-"unused" symbol, add a `// fallow-ignore-*` suppression comment or extend `.fallowrc.json` rather than leaving it as noise.

### The audit ratchet (this gate blocks merges)

`code-audit` is a **required status check** on PRs to `main`. After posting the snapshot, its final step runs [`scripts/audit-gate.cjs`](scripts/audit-gate.cjs), which **fails the build** if either:

1. **Any of the eight zeroable dead-code categories is above 0** — `unused_files`, `unused_exports`, `unused_types`, `unused_class_members`, `duplicate_exports`, `unused_dependencies`, `unlisted_dependencies`, `circular_dependencies`. The fallow-audit remediation cluster drove all eight to 0; this holds the line.
2. **Total jscpd duplication rises above the ceiling (4.0%).** `DUP_CEILING` in `scripts/audit-gate.cjs` is the single source of truth — ratchet it **down** as duplication drops, never up.

What the ratchet does **not** do:

- **Complexity never blocks.** The CRAP / cyclomatic backlog is large and out of scope; complexity stays visible-but-advisory in the snapshot and in `fallow health`.
- It does not gate the non-zeroable dead-code categories (`unused_enum_members`, `unresolved_imports`, `private_type_leaks`) — those are reported, not enforced.

If a PR trips the ratchet, fix the finding (preferred), add a scoped `// fallow-ignore-*` suppression for a deliberate keep, or — only for an intentional ceiling change — adjust `DUP_CEILING` downward with justification. A complementary gate in `fallow.yml` already blocks *new* dead code / duplication introduced on the PR's changed lines (`fail-on-issues: true`, diff-scoped); the `code-audit` ratchet additionally guards against whole-repo regressions.

## Project layout

| Path | Role |
|------|------|
| `backend/src/` | Express API, Sequelize models, CSV import |
| `backend/src/routeRegistry.ts` | Declarative ordered router-mount registry (mount order + auth boundary as data; locked by `backend/test/appRouteOrder.test.ts`) |
| `backend/src/migrations/` | Sequelize migrations (JavaScript) |
| `backend/src/**/*.test.ts` | Colocated unit tests (beside the code). Integration tests in `backend/test/integration/`; migration tests in `backend/src/migrations/__tests__/` |
| `frontend/src/` | React UI |
| `shared/api-types.ts` | API DTO types shared with the frontend |

## Import upload rate limit

`POST /api/import/upload` is limited to **30 requests per minute per IP** (see [`backend/src/routes/importRateLimit.ts`](backend/src/routes/importRateLimit.ts)). In `NODE_ENV=test`, limiting is disabled so automated tests stay stable. Override with **`UPLOAD_RATE_LIMIT_MAX`** (integer) if needed.

## Git hooks

After `yarn install`, Husky runs `yarn prepare`. Staged `frontend/**/*.{ts,tsx}` files trigger **`yarn workspace frontend run lint`** on commit (via [lint-staged](https://github.com/lint-staged/lint-staged)). To skip once: `git commit --no-verify`.
