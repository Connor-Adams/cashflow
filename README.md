# Cashflow

<!-- BADGIE TIME -->
[![CI](https://img.shields.io/github/actions/workflow/status/Connor-Adams/cashflow/ci.yml?branch=main&label=ci)](https://github.com/Connor-Adams/cashflow/actions/workflows/ci.yml)
[![build-images](https://img.shields.io/github/actions/workflow/status/Connor-Adams/cashflow/build-images.yml?branch=main&label=images)](https://github.com/Connor-Adams/cashflow/actions/workflows/build-images.yml)
[![release-drafter](https://img.shields.io/github/actions/workflow/status/Connor-Adams/cashflow/release-drafter.yml?branch=main&label=release)](https://github.com/Connor-Adams/cashflow/actions/workflows/release-drafter.yml)
[![frontend release](https://img.shields.io/github/v/release/Connor-Adams/cashflow?label=frontend)](https://github.com/Connor-Adams/cashflow/releases)
[![backend release](https://img.shields.io/github/v/release/Connor-Adams/cashflow?label=backend)](https://github.com/Connor-Adams/cashflow/releases)
[![package manager: yarn](https://img.shields.io/badge/package_manager-yarn_4.17-blue)](https://yarnpkg.com/)
[![node](https://img.shields.io/badge/node-20%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![typescript](https://img.shields.io/badge/typescript-5.9-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
<!-- END BADGIE TIME -->

A self-hosted finance tracker for one person or a couple — run it on your own
machine or your own server. Drop in your card CSVs and PDF statements, let
merchant rules categorize and split them, attach receipts, track investments
and net worth, plan budgets and forecasts — and see it all roll up into
per-currency summaries. No third-party services touch your data unless you opt
into an integration.

It is a real multi-currency ledger, not a spreadsheet: ~90 tables, ~80 API
routers, an 85-page React app, and an AI layer you can turn on or leave off
entirely.

## Quick start

```bash
yarn setup     # install + run migrations
yarn dev       # API on :3001, UI on :5173 (proxies /api)
```

Open `http://localhost:5173` and click **Continue with demo account** — the
backend seeds a demo household with sample data on startup, so there is
something to look at immediately.

Requires **Node 20+** and **Yarn 4 (Berry)**, pinned via the `packageManager`
field and invoked through [Corepack](https://nodejs.org/api/corepack.html) —
run `corepack enable` once, then the `yarn …` shim resolves to 4.17 (or call
`corepack yarn …` explicitly). This is a Yarn workspace monorepo — always
install and run from the **repo root**, never a sub-directory. If stray
`node_modules` exist inside `backend/` or `frontend/`, delete them and reinstall
at root.

Optional config lives in `backend/.env` (copy from
[`backend/.env.example`](backend/.env.example)). Everything has a working
default — set nothing and it just runs (`DEFAULT_CURRENCY=CAD`).

## The primitives spine

Cashflow is built on **13 canonical primitives** — a primitive is a distinct
*status machine + noun*, not a data shape. The ~90 Sequelize models are the
physical tables; they fold into these 13 concepts:

> **Transaction · Expectation · Account · Holding · Principal · Counterparty ·
> Scenario · Budget · Goal · Proposal · Observation · Document · Period**

Before adding any model, route, or page, the rule is: *does this introduce a new
status machine, or a new variant/view of an existing primitive?* A new variant
is a `type` field on an existing primitive; a new view is a query; a genuinely
new status machine is rare and flagged as a spine change. Full reasoning:
[the primitives spec](docs/superpowers/specs/2026-05-30-cashflow-primitives-design.md).

This is the single most important thing to understand before contributing.

## What it does

**Capture & categorize**
- CSV upload (UI or folder-scan) and PDF statement parsing with reconciliation.
  Auto-detects generic-bank vs Amex layouts; pluggable issuer profiles
  ([docs/csv-import.md](docs/csv-import.md)).
- Merchant-pattern rules apply categories, splits, labels, and notes on import.
- A review inbox surfaces uncategorized or flagged transactions; data-quality
  checks catch anomalies.
- Attach receipts to transactions; keep statements and supporting files in a
  document vault.
- Match Amazon (and other) order reports to card charges for item-level detail
  ([docs/amazon-enrichment.md](docs/amazon-enrichment.md)).

**Split & settle**
- Partner / business / personal splits per transaction, with running settlement
  balances between contacts.
- Recurring-charge and subscription detection, plus money-leak surfacing.

**Plan & analyze**
- Budgets, savings goals, and cash-flow forecasting with planned events and a
  monthly-close flow.
- Debt and credit-card tracking, opportunity-cost and what-if scenarios.
- Personal and corporate tax scenarios, household plans, and reserve estimation.
- Investment holdings with scheduled price quotes (Alpha Vantage) and dividend
  reconciliation, rolled into net-worth tracking.
- Per-currency dashboards (self / partner / business), Sankey flows, insights,
  and an exportable reporting API.

**AI (optional)**
- OpenAI-backed category/split/note suggestions, vision-based receipt
  extraction, and a CFO chat assistant over your own data. Set `OPENAI_API_KEY`
  to enable it; leave it unset and everything else works unchanged.

## Architecture

Three workspaces, one DTO contract:

- **`backend/`** — Express + Sequelize API. Feature modules are the top-level
  dirs under `src/` (`import/`, `portfolio/`, `tax/`, `forecast/`, `budgets/`,
  `ai/`, …), each pairing domain logic with a `routes/*.ts` router. Router
  mounts live in a declarative, CI-locked registry
  ([`backend/src/routeRegistry.ts`](backend/src/routeRegistry.ts)) — mount order
  is load-bearing and `backend/test/appRouteOrder.test.ts` locks it.
- **`frontend/`** — Vite + React 19, react-router v7, Tailwind v4 (Radix,
  lucide, recharts). 85 pages in `pages/`, shared API client in `lib/api.ts`.
  The build also emits Amazon/Apple capture bookmarklets.
- **`shared/`** — a single file, `shared/api-types.ts`, the API DTO contract
  imported by both sides as `@cashflow/shared`.

The DB is **dual-dialect**: Postgres in production (set `DATABASE_URL`), with an
embedded file DB for zero-setup local dev — all Sequelize is written to run on
both. Multi-currency throughout, with
an `FxRate` table. Auth is cookie-session and household-scoped behind a global
`requireAuth` boundary. Observability is pino logs + OpenTelemetry over OTLP;
`infra/` brings up Grafana/Loki/Tempo/Prometheus locally
([docs/observability.md](docs/observability.md)).

### API surface

Everything mounts under `/api`. A few routes (health, version, config, auth,
capture, `/api/v1` reporting, audit) sit *before* `requireAuth`; the rest need a
session. The ~80 routers group into families:

| Family | Examples | Purpose |
|---|---|---|
| System | `/health` `/version` `/config` `/jobs` `/search` | Health, build info, jobs, global search |
| Auth & household | `/auth` `/household` `/invites` `/preferences` | Session auth, membership, prefs |
| Transactions | `/transactions` `/transfers` `/accounts` `/rules` `/labels` `/review-items` | List/filter/patch, rules, review inbox |
| Import & capture | `/import` `/capture` `/amazon` `/sync` `/v1` | CSV/PDF import, bookmarklet capture, reporting export |
| Split & settle | `/contacts` `/settlements` `/partner` | Splits and settlement balances |
| Summaries | `/summary` `/reports` `/insights` `/recurring` `/money-leaks` | Aggregates, Sankey, recurring/leak detection |
| Planning | `/budgets` `/forecast` `/goals` `/debt` `/financial-scenarios` `/cfo` | Budgets, forecasts, scenarios, CFO chat |
| Investments | `/portfolio` `/dividends` `/net-worth` `/fx` | Holdings, prices, dividends, net worth, FX |
| Tax | `/tax` `/tax/scenarios` `/income` | Tax scenarios, household plans, reserve |
| Receipts & docs | `/transactions/:id/receipts` `/vault` | Receipts, vision analysis, document vault |
| AI | `/ai` `/chat` | `GET /ai/status` reports config; suggestions & chat |

[`routeRegistry.ts`](backend/src/routeRegistry.ts) is the authoritative list
(each entry carries a `why`). Folded endpoints return `410 Gone` pointing at
their replacement.

## Configuration

Copy [`backend/.env.example`](backend/.env.example) to `backend/.env`. The most
common knobs:

| Variable | Default | Purpose |
|---|---|---|
| `DEFAULT_CURRENCY` | `CAD` | Fallback when a transaction has no currency |
| `DATABASE_URL` | _(unset)_ | Postgres connection; an embedded file DB is used when unset |
| `CSV_UPLOAD_DIR` | `./uploads/csv` | Folder-scan import source |
| `RECEIPTS_UPLOAD_DIR` | `./uploads/receipts` | Local receipt storage |
| `OPENAI_API_KEY` | _(unset)_ | Enables AI suggestions, vision, chat |
| `ALPHA_VANTAGE_API_KEY` | _(unset)_ | Enables stock quotes + dividends |
| `DEMO_ACCOUNT_ENABLED` | `true` | Seed the demo household on startup |

AI models (`OPENAI_MODEL`, `OPENAI_VISION_MODEL`), the quote scheduler
(`QUOTE_*`), dividend reconciliation (`DIVIDEND_*`), Costco image enrichment
(`COSTCO_*`), and observability (`OTEL_*`) are all documented inline in
`.env.example`.

## Tests

```bash
yarn test    # backend unit + integration + frontend Vitest
yarn ci      # everything CI runs: typecheck, tests, both production builds
```

Backend unit tests are **colocated** (`foo.test.ts` beside `foo.ts` under
`backend/src/`) and auto-discovered — a new test runs with no glob to maintain.
Integration tests live in `backend/test/integration/` (Postgres, via
`test:integration`); migration tests in `backend/src/migrations/__tests__/`.
Backend uses `node:test` via `tsx`; frontend uses Vitest. Single-file and
filter-by-name invocations are in [CLAUDE.md](CLAUDE.md).

## Demo account

Seeded on startup (including in production) unless `DEMO_ACCOUNT_ENABLED=false`:

- Email: `dev@cashflow.local`
- Password: `cashflow-demo`

Override with `DEMO_ACCOUNT_EMAIL` / `DEMO_ACCOUNT_PASSWORD` /
`DEMO_ACCOUNT_NAME`. The seed is idempotent — the user, household, account,
rules, and sample transactions are ensured without duplicating on later deploys.

## Deploy

Image-based and **not** auto-deployed from `main`: CI builds and pushes
`backend`/`frontend` images to GHCR on merge; publishing a GitHub Release
re-tags them `:production` and fires Railway redeploys. The full pipeline,
version-bump rules, and rollback steps are in
[docs/releasing.md](docs/releasing.md); Railway service config and storage in
[docs/deploy-railway.md](docs/deploy-railway.md). Local dev setup, CI parity,
and git hooks are in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Copyright (c) 2026 Connor Adams. All rights reserved.

Source-available for review and evaluation only — **not** open-source. You may
not copy, modify, distribute, host, offer as a service, or use this project
commercially without explicit written permission. See [LICENSE](LICENSE).
