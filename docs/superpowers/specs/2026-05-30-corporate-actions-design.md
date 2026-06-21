# Corporate actions in the investment activity editor (issue #301)

## Problem

Real-world corporate actions — stock dividends (dividend in kind), spin-offs,
mergers, and return of capital — are wider than the buy/sell/split/DRIP set the
investment activity pipeline exercises today. When one happens the user has no
way to record it and the adjusted cost base (ACB) drifts, so capital-gain math
at the next sale is wrong.

## Reality check (issue assumptions vs. codebase)

The issue body assumes infrastructure that does **not** exist. The design below
reconciles intent with what the codebase actually supports.

| Issue assumption | Reality | Resolution |
| --- | --- | --- |
| ACB engine at `backend/src/services/acb.ts` | It's `backend/src/portfolio/acb.ts` | Extend the real file. |
| "Existing `POST /api/investment-activities`" | No create endpoint exists; activities are import-only (`commitStatementImport.ts`, `reconcileDividends.ts`) | Add `POST /api/portfolio/activities`. |
| ACB persisted on a "security row", recomputed and saved | ACB is **never persisted**; it's derived on-read per `(account, security)` by `computeAcb` (3 call sites in `portfolio.ts`, plus tax builders) | "Recompute on save" is satisfied automatically by on-read derivation. The frontend invalidates the security query after save. |
| "Portfolio activity entry form" already exists | No activity-entry form exists; `PortfolioSecurityPage` only displays activities read-only | Add a compact form to `PortfolioSecurityPage` (the only place with the activities table + security context). |
| `return_of_capital` is new | Already implemented in `acb.ts` (with deemed-gain on excess per CRA s.53(2)(a)(ii), shipped PR #109) | Keep as-is; add tests asserting AC#6. |

## ACB math (the core)

The ACB engine is single-security and stateless: `computeAcb(activities[])`
walks one security's stream. Cross-security actions are handled by writing a
basis-injection activity onto the **recipient** security's stream at save time,
so each stream stays single-security and the pure engine needs no global state.

New `AcbActivity` fields: `costBasisAllocationPct`, `cashComponent`,
`recipientSecurityId` (the last is carried for the coordination layer; the math
uses only the first two).

- **dividend_in_kind** — adds `quantity` shares at **zero** incremental cost.
  `totalCost` unchanged; per-unit ACB = `totalCost / (qty + shares)` drops. No
  realized event. (AC#3 formula: `new_basis = old_total_basis / new_total_shares`.)
- **spin_off** (parent stream) — parent keeps `(1 - pct)` of `totalCost`;
  reduce by `pct * totalCost`. No quantity change, no realized event. The
  recipient receives `pct * old_basis` via a `transfer_in` written to its own
  stream at save time (AC#4).
- **merger** (source stream) — the source position is disposed: record a
  realized event for the cash consideration (`cashComponent * qty` as proceeds
  against the proportional removed cost), then zero out the source position and
  basis. The recipient receives `(old_basis - cash_proceeds)` via a
  `transfer_in` on its own stream (AC#5).
- **return_of_capital** — already implemented; reduces `totalCost` by
  `min(amount, totalCost)`, excess becomes an immediate deemed capital gain
  (AC#6).

All four are covered by pure, hand-computed unit tests in
`backend/test/portfolio/acb.test.ts`.

## Data model

Migration `backend/src/migrations/<ts>-corporate-actions.js` (forward + backward):

- `investment_activities.recipient_security_id BIGINT NULL` (FK `securities`).
- `investment_activities.cost_basis_allocation_pct DECIMAL(5,4) NULL` (0..1).
- `investment_activities.cash_component DECIMAL(18,4) NULL`.

Reversible `down` drops exactly these three columns. A round-trip migration test
(`backend/test/migrations/corporateActionsMigration.test.ts`) asserts up adds
them, down removes them, and existing rows are untouched (fills a pre-existing
gap — `split_ratio` shipped without a migration test).

Model `InvestmentActivity.ts` gains the three nullable fields (camelCase mapped
to snake_case columns, matching `splitRatio`).

## API surface

`POST /api/portfolio/activities` (auth + `visibleAccountWhere` scope):

Body: `accountId`, `securityId`, `activityType`, `tradeDate`, `quantity?`,
`amount?`, `recipientSecurityId?`, `costBasisAllocationPct?`, `cashComponent?`,
`description?`.

Validation per type (400 with a specific `code`):

- `dividend_in_kind`: `quantity > 0` → else `DIVIDEND_IN_KIND_REQUIRES_SHARES`.
- `spin_off`: `recipientSecurityId` (`SPINOFF_REQUIRES_RECIPIENT`), `quantity > 0`,
  `costBasisAllocationPct` in `(0, 1]` (`SPINOFF_ALLOCATION_OUT_OF_RANGE`).
- `merger`: `recipientSecurityId` (`MERGER_REQUIRES_RECIPIENT`), `quantity > 0`;
  `cashComponent` optional (hidden/transfers full basis when absent).
- `return_of_capital`: `amount > 0` → else `ROC_REQUIRES_AMOUNT`.
- The recipient security and account must be visible to the caller and in the
  household; `spin_off`/`merger` recipient must be a real security.

On success the endpoint creates the primary activity and, for `spin_off`/
`merger`, the recipient `transfer_in` activity in one transaction, with a
synthesized `sourceRowFingerprint` and `importBatch = 'manual'` (both NOT NULL).
Returns `{ activity, recipientActivity? }`.

Existing buy/sell/split/DRIP activities continue to flow through the import
pipeline unchanged (AC#10).

## Frontend

`PortfolioSecurityPage` gains a collapsible "Add corporate action" form above
the activities table (it already has the security + accounts + activities in
context):

- Activity-type dropdown with 8 labels (issue copy): Buy, Sell, Split, DRIP,
  Dividend in kind (stock dividend), Spin-off, Merger / acquisition, Return of
  capital. Buy/Sell/Split/DRIP reuse the existing minimal fields.
- Conditional fields per type with the issue's exact labels + help text.
- Inline validation mirrors the API rules (allocation 0–1, recipient required,
  amount/shares > 0) and blocks submit (AC#8).
- A recipient-security picker (the household's securities) for spin_off/merger.
- On submit, POST to the new endpoint; on success invalidate the security-detail
  query so the cost-basis row refreshes without a full reload (AC#9); toast on
  the documented error/success states.

Tailwind v4 utilities; no new design tokens.

## Acceptance criteria → coverage

1. Migration adds the 3 columns, reversible — `corporateActionsMigration.test.ts`.
2. POST accepts the new types, enforces required fields — `portfolioActivities.test.ts`.
3. `dividend_in_kind` ACB formula — `acb.test.ts`.
4. `spin_off` reduces parent basis + creates recipient holding/basis — `acb.test.ts` + `portfolioActivities.test.ts`.
5. `merger` zeros source basis, transfers to recipient less cash — `acb.test.ts` + `portfolioActivities.test.ts`.
6. `return_of_capital` reduces ACB; excess → deemed gain in UI — `acb.test.ts` + endpoint test.
7. Form dropdown with 8 values + per-type fields — `PortfolioSecurityPage` component test.
8. Inline validation per invalid case — component test.
9. ACB recompute (on-read) updates the row without reload — query invalidation, component test.
10. Existing buy/sell/split/DRIP unchanged — existing `acb.test.ts` stays green; display snapshot.

## Out of scope (per issue)

Automated detection from feeds; jurisdiction-specific tax treatment; full
historical retroactive recompute across the portfolio; activity-edit audit log
(#228); bulk CSV import of corporate actions.

## Deviations from the issue (documented in the PR)

- Endpoint is `POST /api/portfolio/activities` (no `/api/investment-activities`
  router exists).
- "Recompute on save → update persisted cost basis" is satisfied by the existing
  on-read ACB derivation + a frontend query invalidation; no ACB is persisted.
- The form lives on `PortfolioSecurityPage` (the only page with an activities
  table and security context), not a vague "PortfolioPage activity entry form."
- Cross-security basis transfer (spin_off/merger) is implemented by writing a
  `transfer_in` basis-injection activity onto the recipient security's stream,
  keeping the ACB engine purely single-security.
