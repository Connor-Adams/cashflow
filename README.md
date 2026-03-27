# Cashflow

Local-first personal and partner expense tracker: import card CSVs, apply merchant rules, override categorization and splits, and view per-currency summaries.

## Stack

- **Backend:** Node.js, Express, Sequelize, SQLite
- **Frontend:** React (Vite, TypeScript), Recharts

## Quick start

From the **repo root**, dependencies are installed once for **backend** and **frontend** ([npm workspaces](https://docs.npmjs.com/cli/using-npm/workspaces)). If you still have old `node_modules` only inside `backend/` or `frontend/`, delete those folders and reinstall from the root.


**Yarn**

```bash
yarn install
yarn db:migrate
yarn dev
```

**npm**

```bash
npm install
npm run db:migrate
npm run dev
```

**All-in-one** (install deps + run migrations; then start dev yourself):

```bash
yarn setup && yarn dev
# or
npm run setup && npm run dev
```

Optional: copy `backend/.env.example` to `backend/.env`. Defaults use `backend/data/cashflow.sqlite`, `backend/uploads/csv`, and **`DEFAULT_CURRENCY=CAD`** (override in `.env` if needed).

With `yarn dev` / `npm run dev`:

- API: `http://localhost:3001` (proxied as `/api` from Vite)
- UI: `http://localhost:5173`

## CSV import

### Web upload (recommended)

1. Under **Accounts**, create at least one account (name, optional short code for filename matching, default currency).
2. Open **Transactions**, use **Upload CSV**: pick the account, optional batch label, CSV profile, and your `.csv` file → **Import CSV**.
3. Same parsing, rules, and dedupe as folder import; filename does not need a special pattern when you choose the account in the form.

### Folder scan (optional)

1. Create an account whose `short_code` or `name` matches the card token in the filename.
2. Put files in `CSV_UPLOAD_DIR` as `CardName_YYYY_MM.csv` (e.g. `Amex_2025_01.csv`).
3. Use **Run import** on Transactions or `POST /api/import/run`.

### API

- `POST /api/import/upload` — multipart field `file` (required), `accountId` (required), optional `batchLabel`, `profileId`.
- `POST /api/import/run` — scan folder only.

### Column mapping (profiles)

Profiles live in `backend/src/import/csvProfiles.js`. The default `generic_simple` profile expects headers such as `Date`, `Description`, `Amount`, and optional `Currency`. Amounts follow **charges_negative** (spending is negative after normalization).

**American Express:** Use profile **`generic_amex`** or **`amex`** on upload. It recognizes many Amex column names (e.g. `Transaction Date`, `Posted Date`, `Charge Amount`, `Amount (CAD)`). Dates are parsed flexibly (US `MM/DD/YYYY`, Canadian `DD/MM/YYYY`, ISO `YYYY-MM-DD`, etc.).

To match another issuer, add a profile or set `CSV_PROFILE_ID` / pass `profileId` on import.

## Scripts

Run from the repo root (`yarn <script>` or `npm run <script>`):

| Command | Description |
|--------|-------------|
| `setup` | `install` + `db:migrate` (first-time or after pulling migrations) |
| `dev` | API + Vite dev servers |
| `db:migrate` | Apply Sequelize migrations |
| `build` | Production build of the frontend |
| `test` | Backend unit tests |

## Tests

```bash
yarn test
# or
npm run test
```

Covers split math, rule matching, and CSV row mapping. Sample CSV: `backend/test/fixtures/sample.csv`.

## API overview

- `GET|POST|DELETE /api/accounts/:id` — list, create, delete account (delete removes all transactions for that account first)
- `GET /api/transactions` — pagination and filters (`reviewFlag`, `currency`, `dateFrom`, `dateTo`, …)
- `PATCH /api/transactions/:id` — overrides; recalculates share amounts
- `GET|POST|PATCH|DELETE /api/rules` — merchant rules
- `POST /api/import/upload` — multipart: `file`, `accountId`, optional `batchLabel`, `profileId`
- `POST /api/import/run` — scan `CSV_UPLOAD_DIR` and import new files
- `GET /api/summary/dashboard|partner|business` — aggregates (per currency; use `currency` query to filter)
