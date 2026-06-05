# Cashflow

<!-- BADGIE TIME -->
[![CI](https://img.shields.io/github/actions/workflow/status/Connor-Adams/cashflow/ci.yml?branch=main&label=ci)](https://github.com/Connor-Adams/cashflow/actions/workflows/ci.yml)
[![build-images](https://img.shields.io/github/actions/workflow/status/Connor-Adams/cashflow/build-images.yml?branch=main&label=images)](https://github.com/Connor-Adams/cashflow/actions/workflows/build-images.yml)
[![release-drafter](https://img.shields.io/github/actions/workflow/status/Connor-Adams/cashflow/release-drafter.yml?branch=main&label=release)](https://github.com/Connor-Adams/cashflow/actions/workflows/release-drafter.yml)
[![frontend release](https://img.shields.io/github/v/release/Connor-Adams/cashflow?label=frontend)](https://github.com/Connor-Adams/cashflow/releases)
[![backend release](https://img.shields.io/github/v/release/Connor-Adams/cashflow?label=backend)](https://github.com/Connor-Adams/cashflow/releases)
[![package manager: yarn](https://img.shields.io/badge/package_manager-yarn_1.22-blue)](https://classic.yarnpkg.com/)
[![node](https://img.shields.io/badge/node-20%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![typescript](https://img.shields.io/badge/typescript-5.9-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
<!-- END BADGIE TIME -->

Local-first personal and partner expense tracker. Import card CSVs, apply
merchant rules, split with a partner, attach receipts, and roll spend up into
per-currency summaries — all running on your own machine.

## Features

- **Imports** — CSV upload from the UI or folder-scan import. Auto-detects
  generic-bank vs Amex layouts; pluggable profiles for other issuers.
  See [docs/csv-import.md](docs/csv-import.md).
- **Rules** — merchant-pattern rules apply categories, splits, and notes to
  matching transactions on import.
- **Review inbox** — uncategorized or flagged transactions surface for review
  in one place.
- **Splits and settlements** — partner / business / personal splits per
  transaction, with running settlement balances.
- **Recurring** — detection and tracking of subscriptions and recurring
  charges.
- **Receipts** — attach JPEG/PNG/WebP receipts to a transaction.
- **AI suggestions** (optional) — OpenAI-backed category / split / note
  suggestions; vision-based receipt extraction.
- **Amazon enrichment** — match Amazon order reports to card transactions for
  item-level categories. See [docs/amazon-enrichment.md](docs/amazon-enrichment.md).
- **Portfolio** — track investment balances alongside spending.
- **Dashboards and reports** — per-currency summaries for self, partner, and
  business.

## Quick start

```bash
yarn setup     # install + run migrations
yarn dev       # API + Vite together
```

- API: `http://localhost:3001`
- UI: `http://localhost:5173` (proxies `/api` to the API)

Requires **Node 20+** and **Yarn Classic v1**. Yarn workspaces cover
`backend`, `frontend`, and `shared` — install from the repo root, not from
sub-directories. If old `node_modules` exist inside `backend/` or `frontend/`,
delete them and reinstall from the root.

Optional: copy `backend/.env.example` to `backend/.env`. Defaults use
`backend/data/cashflow.sqlite`, `backend/uploads/csv`, and
`DEFAULT_CURRENCY=CAD`.

For full dev setup (CI parity, git hooks, project layout) see
[CONTRIBUTING.md](CONTRIBUTING.md).

## Configuration

Key environment variables (set in `backend/.env`):

| Variable | Default | Purpose |
|---|---|---|
| `DEFAULT_CURRENCY` | `CAD` | Fallback currency when a transaction has none |
| `DATABASE_URL` | _(unset)_ | Postgres connection string; SQLite is used when unset |
| `CSV_UPLOAD_DIR` | `backend/uploads/csv` | Folder-scan import source |
| `RECEIPTS_UPLOAD_DIR` | `backend/uploads/receipts` | Local receipt storage path (when not using S3) |
| `OPENAI_API_KEY` | _(unset)_ | Enables AI suggestion and vision endpoints |
| `DEMO_ACCOUNT_ENABLED` | `true` | Seed a demo account on startup |
| `UPLOAD_RATE_LIMIT_MAX` | `30` | CSV upload requests per IP per minute |

Set `OPENAI_API_KEY` to enable AI features; without it, the rest of the app
works unchanged and the UI shows how to enable AI.

## API overview

All endpoints are under `/api`. Authentication uses cookie sessions; mutating
routes require login.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Health check |
| `POST` | `/auth/register \| login \| demo-login \| logout` | Auth |
| `GET` | `/auth/me` | Current user |
| `GET\|POST\|DELETE` | `/accounts[/:id]` | Manage accounts |
| `GET\|POST\|PATCH\|DELETE` | `/rules[/:id]` | Merchant rules |
| `GET` | `/transactions` | List with filters (`reviewFlag`, `currency`, `dateFrom`, `dateTo`, …) |
| `PATCH` | `/transactions/:id` | Override category / split / notes |
| `POST` | `/transactions/bulk-patch[-filter]` | Bulk edit by ids or by filter |
| `POST` | `/transactions/:id/ai-suggest` | Single AI suggestion (requires `OPENAI_API_KEY`) |
| `POST` | `/transactions/bulk-ai-suggest` | Batch AI suggestions (max 15 ids) |
| `POST` | `/import/upload` | Multipart CSV upload: `file`, `accountId`, optional `batchLabel`, `profileId` |
| `POST` | `/import/run` | Scan `CSV_UPLOAD_DIR` for new files |
| `GET` | `/import/profiles` | List CSV profiles |
| `GET` | `/summary/dashboard \| partner \| business \| monthly` | Aggregates (per currency; filter with `?currency=`) |
| `GET\|POST\|DELETE` | `/contacts[/:id]` | Partner / payee contacts |
| `GET\|POST\|DELETE` | `/settlements[/:id]` | Settle balances between contacts |
| `GET` | `/recurring` | Detected recurring charges |
| `GET\|POST` | `/portfolio[/prices/refresh]` | Investment holdings + price refresh |
| `GET\|POST\|PATCH\|DELETE` | `/amazon/...` | Order import, matching, item categorization, link review |
| `POST` | `/transactions/:id/receipts` | Upload receipt (multipart `file`) |
| `GET` | `/transactions/:id/receipts` | List receipts for a transaction |
| `GET\|DELETE` | `/receipts/:id[/file]` | Download or delete a receipt |
| `POST` | `/receipts/:id/analyze` | Vision-based extraction (requires `OPENAI_API_KEY`) |
| `GET` | `/ai/status` | `{ "openai": true }` when configured |

## Tests

```bash
yarn test    # backend unit + integration + frontend Vitest
yarn ci      # everything CI runs: typecheck, tests, production builds
```

Backend unit tests are **colocated** (`foo.test.ts` beside `foo.ts` under
`backend/src/`) and auto-discovered, so a new test runs with no glob to maintain.
Integration tests live in `backend/test/integration/` (Postgres, run via
`test:integration`); migration tests live in `backend/src/migrations/__tests__/`.

Coverage spans split math, rule matching, CSV row mapping, env validation,
import integration (HTTP + DB), and frontend unit tests. Sample CSV:
`backend/test/fixtures/sample.csv`.

## Demo account

The backend seeds a demo account on startup (including in production) unless
`DEMO_ACCOUNT_ENABLED=false`. Defaults:

- Email: `dev@cashflow.local`
- Password: `cashflow-demo`

Override with `DEMO_ACCOUNT_EMAIL`, `DEMO_ACCOUNT_PASSWORD`, and
`DEMO_ACCOUNT_NAME`. The seed is idempotent: the demo user, household,
account, rules, and sample transactions are ensured without duplicating on
later deploys. The auth screen exposes a **Continue with demo account** button
backed by `POST /api/auth/demo-login`.

## Releases

Cashflow uses a three-piece pipeline:

1. **CI builds Docker images** on every push to `main` and pushes them to
   GitHub Container Registry (GHCR), tagged with the commit SHA.
2. **[Release Drafter](https://github.com/release-drafter/release-drafter)**
   maintains a draft GitHub Release with auto-generated notes from merged
   PR titles.
3. **Publishing a release** re-tags the corresponding images as
   `:vX.Y.Z` and `:production`, then triggers Railway to redeploy.
   Railway services are configured to pull images from GHCR — they don't
   build anything themselves.

**To ship to production:**

1. Open a PR with a conventional-commit title (`feat:`, `fix:`, `docs:`, etc.).
   Release Drafter auto-labels the PR based on the title prefix.
2. When the PR merges to `main`:
   - The `build-images` workflow builds the backend and frontend images and
     pushes them to GHCR (`ghcr.io/connor-adams/cashflow-{backend,frontend}:sha-<short>`).
   - Release Drafter updates the draft GitHub Release with the new entry.
3. When ready to ship, go to **Releases → Drafts** in GitHub. **Wait for the
   `build-images` run on the latest `main` commit to finish** before
   publishing — the promote workflow re-tags those images, and will fail
   fast if they don't exist yet. Eyeball the notes and version, edit if
   needed, click **Publish release**.
4. Publishing fires a `release: published` event (human action, not
   `GITHUB_TOKEN`). The `promote-to-production` workflow:
   - Re-tags the released commit's images as `:vX.Y.Z` and `:production`.
   - Calls Railway's deploy hooks for both services.
   Railway pulls the new `:production` image and runs it.

`main` does not auto-deploy. Only publishing a release triggers a Railway
redeploy.

**Version bumps (suggested by Drafter; override at Publish time):**
- `feat:` → minor bump
- `fix:` / `perf:` / `deps:` → patch bump
- `feat!:` or any title with `!` after the type → major bump
- `docs:`, `chore:`, `refactor:`, `test:`, `build:`, `ci:` → fall to patch
  default; you choose whether to publish a release with only these

**Required GitHub Secrets:**
- `VITE_API_BASE` — public URL of the backend Railway service, baked into
  the frontend image at build time
- `RAILWAY_TOKEN` — Railway project token used by the promote workflow to
  call `railway redeploy` against each service

**Rollback:**

Re-tag an older `:vX.Y.Z` image as `:production`, then trigger Railway
redeploys. From a workstation with `docker buildx` and the Railway CLI
linked to the project:

```bash
TAG=v0.1.4
IMG_BE=ghcr.io/connor-adams/cashflow-backend
IMG_FE=ghcr.io/connor-adams/cashflow-frontend

docker buildx imagetools create --tag $IMG_BE:production $IMG_BE:$TAG
docker buildx imagetools create --tag $IMG_FE:production $IMG_FE:$TAG

railway redeploy --service 42977748-ab5c-4552-a206-faf86d353e5b -y
railway redeploy --service e0dc05b7-3961-4d4f-aea9-bed3810ea2f5 -y
```

A dedicated `workflow_dispatch` rollback workflow would be cleaner but is
not currently configured.

## Deploy

See [docs/deploy-railway.md](docs/deploy-railway.md) for Railway service
configuration, environment variables, and storage setup (Postgres, volume
mount for folder imports, Railway Buckets for receipts).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for dev setup, individual workspace
commands, CI parity, project layout, and git hooks.

Design specs and implementation plans live under
[docs/superpowers/](docs/superpowers).

AI-agent audit loop (verifying a deploy is healthy): [docs/agent-audit.md](docs/agent-audit.md).

## License

Copyright (c) 2026 Connor Adams. All rights reserved.

This repository is source-available for review and evaluation only. It is not
open-source software. You may not copy, modify, distribute, host, offer as a
service, or use this project commercially without explicit written permission.
See [LICENSE](LICENSE) for details.
