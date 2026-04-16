# Cashflow

Local-first personal and partner expense tracker: import card CSVs, apply merchant rules, override categorization and splits, and view per-currency summaries.

## Stack

- **Backend:** Node.js, Express, Sequelize, SQLite (TypeScript)
- **Frontend:** React (Vite, TypeScript), Recharts
- **Package manager:** [Yarn Classic](https://classic.yarnpkg.com/) (v1) at the repo root — workspaces cover **backend**, **frontend**, and **shared**.

## Quick start

From the **repo root**, install once for all packages ([Yarn workspaces](https://classic.yarnpkg.com/en/docs/workspaces/)). If you still have old `node_modules` only inside `backend/` or `frontend/`, delete those folders and reinstall from the root.

```bash
yarn install
yarn db:migrate
yarn dev
```

**All-in-one** (install deps + run migrations):

```bash
yarn setup
```

Then start dev with `yarn dev`.

Optional: copy `backend/.env.example` to `backend/.env`. Defaults use `backend/data/cashflow.sqlite`, `backend/uploads/csv`, and **`DEFAULT_CURRENCY=CAD`** (override in `.env` if needed). Developer setup, CI parity, and git hooks: [CONTRIBUTING.md](CONTRIBUTING.md).

With `yarn dev`:

- API: `http://localhost:3001` (proxied as `/api` from Vite)
- UI: `http://localhost:5173`

**Using npm instead:** same scripts work with `npm run <script>` and `npm install` from the root (npm workspaces). Prefer one lockfile — this repo is maintained with **`yarn.lock`** only.

## CSV import

### Web upload (recommended)

1. Under **Accounts**, create at least one account (name, optional short code for filename matching, default currency).
2. Open **Transactions**, use **Upload CSV**: pick the account, optional batch label, and your `.csv` file → **Import CSV**. Leave the profile on **Automatic** to detect column layout from the file (Amex vs generic bank exports), or choose a specific profile if you need to override.
3. Use **Preview first rows** to sanity-check parsing before importing.
4. Same parsing, rules, and dedupe as folder import; filename does not need a special pattern when you choose the account in the form.

### Folder scan (optional)

1. Create an account whose `short_code` or `name` matches the card token in the filename.
2. Put files in `CSV_UPLOAD_DIR` as `CardName_YYYY_MM.csv` (e.g. `Amex_2025_01.csv`).
3. Use **Run import** on Transactions or `POST /api/import/run`.

### API

- `POST /api/import/upload` — multipart field `file` (required), `accountId` (required), optional `batchLabel`, `profileId`.
- `POST /api/import/run` — scan folder only.

### Column mapping (profiles)

Automatic mode scores your CSV’s headers and the first rows against built-in profiles and picks **`generic_simple`** (ISO-style dates and common bank columns) or **`generic_amex`** (Amex-style columns and US date order). Override with **`generic_simple`**, **`generic_amex`**, or **`amex`** when needed.

Profiles are defined in `backend/src/import/csvProfiles.ts`. The default `generic_simple` profile expects headers such as `Date`, `Description`, `Amount`, and optional `Currency`. Amounts follow **charges_negative** (spending is negative after normalization).

**American Express:** **`generic_amex`** recognizes many Amex column names (e.g. `Transaction Date`, `Posted Date`, `Charge Amount`, `Amount (CAD)`). Dates are parsed flexibly (US `MM/DD/YYYY`, Canadian `DD/MM/YYYY`, ISO `YYYY-MM-DD`, etc.).

To match another issuer, add a profile or set `CSV_PROFILE_ID` / pass `profileId` on import (use `auto` or omit for automatic detection when not setting env).

## Scripts

Run from the repo root:

| Command | Description |
|--------|-------------|
| `yarn setup` | `install` + `db:migrate` (first-time or after pulling migrations) |
| `yarn dev` | API + Vite dev servers |
| `yarn db:migrate` | Apply Sequelize migrations |
| `yarn build` | Production build of backend + frontend |
| `yarn test` | Backend unit + integration tests, frontend Vitest |
| `yarn ci` | Typecheck, all tests, production builds (same as CI) |

## Tests

```bash
yarn test
```

Covers split math, rule matching, CSV row mapping, env validation, import integration (HTTP + DB), and frontend unit tests. Sample CSV: `backend/test/fixtures/sample.csv`.

## API overview

- `GET|POST|DELETE /api/accounts/:id` — list, create, delete account (delete removes all transactions for that account first)
- `GET /api/transactions` — pagination and filters (`reviewFlag`, `currency`, `dateFrom`, `dateTo`, …)
- `PATCH /api/transactions/:id` — overrides; recalculates share amounts
- `GET|POST|PATCH|DELETE /api/rules` — merchant rules
- `POST /api/import/upload` — multipart: `file`, `accountId`, optional `batchLabel`, `profileId`
- `POST /api/import/run` — scan `CSV_UPLOAD_DIR` and import new files
- `GET /api/summary/dashboard|partner|business` — aggregates (per currency; use `currency` query to filter)
