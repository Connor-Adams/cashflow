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

The CI `code-audit` job runs both informationally (never blocks merges) and **posts a sticky pull-request comment** — a whole-repo health snapshot (dead code + complexity from fallow, duplication from jscpd) updated in place on each push. The separate `fallow.yml` workflow adds **inline review comments** on changed lines; its own summary comment is disabled (`comment: false`) in favour of the rendered one.

```bash
yarn audit:code   # fallow audit (changed files) + jscpd
yarn deadcode     # fallow dead-code — unused files, exports, types, deps
yarn health       # fallow health — complexity / CRAP / maintainability
yarn dupes        # jscpd — writes reports/jscpd/html/
```

- The PR comment is rendered by `scripts/audit-summary.cjs` from the JSON reports under `reports/`.
- jscpd's `threshold` (5% duplicated lines) acts as a ratchet — lower it as duplication drops.
- To keep a knowingly-"unused" symbol, add a `// fallow-ignore-*` suppression comment or extend `.fallowrc.json` rather than leaving it as noise.

## Project layout

| Path | Role |
|------|------|
| `backend/src/` | Express API, Sequelize models, CSV import |
| `backend/src/migrations/` | Sequelize migrations (JavaScript) |
| `frontend/src/` | React UI |
| `shared/api-types.ts` | API DTO types shared with the frontend |

## Import upload rate limit

`POST /api/import/upload` is limited to **30 requests per minute per IP** (see [`backend/src/routes/importRateLimit.ts`](backend/src/routes/importRateLimit.ts)). In `NODE_ENV=test`, limiting is disabled so automated tests stay stable. Override with **`UPLOAD_RATE_LIMIT_MAX`** (integer) if needed.

## Git hooks

After `yarn install`, Husky runs `yarn prepare`. Staged `frontend/**/*.{ts,tsx}` files trigger **`yarn workspace frontend run lint`** on commit (via [lint-staged](https://github.com/lint-staged/lint-staged)). To skip once: `git commit --no-verify`.

## Code-audit findings and issue triage

The `audit-new-findings` workflow opens GitHub issues automatically when fallow or jscpd
detect new dead code, complexity regressions, or duplication on pushes to `main`.

- Issues are labelled `chore` + `code-audit` + `audit:dead-code` / `audit:complexity` / `audit:dupe`.
- To suppress a known-good symbol from future findings, add a `// fallow-ignore-*` comment or extend `.fallowrc.json`.
- Do **not** mark an audit issue as Won't Fix without a suppression — the next push will re-open it.

## Grafana alert issues

Firing Grafana alerts automatically become `bug` + `incident` issues (see `docs/observability.md`
for the contact-point setup). When you fix the underlying cause and the alert resolves, the issue
is automatically closed. If you need to close it manually before the alert resolves, add an
`alert:<name>` label so the dedup logic still works when the alert fires again.
