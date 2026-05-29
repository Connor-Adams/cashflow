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

## Code health: dead code & duplication

Two static-analysis tools are wired in to find unused code and copy-paste duplication. They run informationally in CI (the `code-audit` job), which **posts the results as a sticky pull-request comment** (updated in place on each push) and never blocks merges — the goal is to drive the baseline down over time.

```bash
yarn audit:code     # runs both tools
yarn deadcode       # knip: unused files, exports, types, dependencies
yarn deadcode:fix   # knip --fix: auto-remove safe unused exports/files (review the diff!)
yarn dupes          # jscpd: duplicate-code detector, writes reports/jscpd/html/
```

- **[knip](https://knip.dev)** (`knip.json`) understands the yarn-workspace layout and reports unused files, exports, exported types, and dependencies across `backend` / `frontend` / `shared`.
- **[jscpd](https://github.com/kucherenko/jscpd)** (`.jscpd.json`) reports duplicated blocks; open `reports/jscpd/html/index.html` for a browsable view. The `threshold` (5% duplicated lines) acts as a ratchet — lower it as duplication drops.

When you knowingly keep an "unused" export (e.g. a public API or test seam), add it to the relevant `knip.json` workspace `ignore`/`ignoreDependencies` entry rather than leaving it as noise.

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
