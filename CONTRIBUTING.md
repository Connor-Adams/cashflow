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
