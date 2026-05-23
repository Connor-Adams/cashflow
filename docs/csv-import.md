# CSV import

Two ways to bring transactions into Cashflow.

## Web upload (recommended)

1. Under **Accounts**, create at least one account (name, optional short code
   for filename matching, default currency).
2. Open **Transactions** → **Upload CSV**: pick the account, optional batch
   label, and your `.csv` file → **Import CSV**. Leave the profile on
   **Automatic** to detect column layout, or choose a specific profile to
   override.
3. Use **Preview first rows** to sanity-check parsing before importing.

Same parsing, rules, and dedupe as folder import. Filename does not need a
special pattern when you choose the account in the form.

## Folder scan (optional)

1. Create an account whose `short_code` or `name` matches the card token in
   the filename.
2. Put files in `CSV_UPLOAD_DIR` as `CardName_YYYY_MM.csv`
   (e.g. `Amex_2025_01.csv`).
3. Use **Run import** on Transactions or `POST /api/import/run`.

## Profiles

Profiles map a CSV's columns to Cashflow's transaction schema. They live in
[`backend/src/import/csvProfiles.ts`](../backend/src/import/csvProfiles.ts).

Automatic mode scores headers and the first rows against built-in profiles and
picks:

- **`generic_simple`** — ISO-style dates, common bank columns (`Date`,
  `Description`, `Amount`, optional `Currency`). Amounts follow
  **charges_negative** (spending is negative after normalization).
- **`generic_amex`** — Amex-style columns (e.g. `Transaction Date`,
  `Posted Date`, `Charge Amount`, `Amount (CAD)`) with US date order.
  Dates are parsed flexibly: US `MM/DD/YYYY`, Canadian `DD/MM/YYYY`,
  ISO `YYYY-MM-DD`.

Override automatic detection by setting `CSV_PROFILE_ID` or passing `profileId`
on import. Use `auto` (or omit) for automatic detection.

To support a new issuer, add a profile to `csvProfiles.ts`.

## Rate limit

`POST /api/import/upload` is limited to **30 requests per minute per IP**.
Override with `UPLOAD_RATE_LIMIT_MAX=<integer>`. Limiting is disabled in
`NODE_ENV=test`.
