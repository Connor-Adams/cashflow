# Cashflow

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

Cashflow uses [release-please](https://github.com/googleapis/release-please) to
manage versions from conventional commits, plus a `production` branch that
Railway tracks for deployment.

**To ship to production:**

1. Make changes on a feature branch; merge to `main` via PR with a conventional
   commit message (`feat:`, `fix:`, etc.). The prefix determines the next
   version bump.
2. `release-please` watches `main` and maintains an open release PR titled
   "chore(main): release X.Y.Z" with the proposed version bump and updated
   `CHANGELOG.md`.
3. When you're ready to ship, merge the release PR. This creates a git tag, a
   GitHub Release, and fast-forwards the `production` branch to the tagged
   commit.
4. Railway tracks `production` and deploys both backend and frontend services
   on each push.

`main` does not auto-deploy to prod. Only release-PR merges advance
`production`.

**Version bumps follow semver:**
- `feat:` → minor bump
- `fix:` / `perf:` / `deps:` → patch bump
- `feat!:` or any commit body containing `BREAKING CHANGE:` → major bump
- `docs:`, `chore:`, `refactor:`, `test:`, `build:`, `ci:` → no bump; shown in
  CHANGELOG under hidden sections

**Rollback:**

```bash
git push origin <older-tag>:refs/heads/production --force-with-lease
```

Must be done by an account in the production branch protection allowlist (or
by anyone if protection isn't configured).

## Deploy

See [docs/deploy-railway.md](docs/deploy-railway.md) for Railway service
configuration, environment variables, and storage setup (Postgres, volume
mount for folder imports, Railway Buckets for receipts).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for dev setup, individual workspace
commands, CI parity, project layout, and git hooks.

Design specs and implementation plans live under
[docs/superpowers/](docs/superpowers).
