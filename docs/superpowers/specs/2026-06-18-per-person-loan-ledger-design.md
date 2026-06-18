# Per-person loan ledger — design

**Date:** 2026-06-18
**Status:** approved (design), pending implementation plan

## Problem

The dashboard "loaned out" tile (`owedBack`, `backend/src/routes/summary.ts:265`)
reads near-zero. It sums `Reimbursement` claims (source-txn dated in the dashboard
window) plus partner-share splits. Two compounding reasons it's empty:

1. The prod `reimbursements` table has **0 rows** — no loan has ever been recorded
   as a tracked claim.
2. The user's actual loans (to contacts Caelan=id1, Stephen Masseur=id4) exist only
   as raw `txn_type='transfer'` e-transfers, never linked to a Reimbursement.

On top of that, counterparty linkage is essentially empty: only ~5 transactions
have `counterparty_contact_id` set, only 47/4976 have `counterparty_raw`. The
person names live in `merchant_raw`/`merchant_clean`
(e.g. "E-TRANSFER RECEIVED STEPHEN MASSEUR",
"ONLINE TRANSFER RECEIVED - CAELAN ANTHONY ITEN-MCGRATH"). Text-matching merchant
fields finds 184 Stephen + 82 Caelan transfers.

The user wants a blend: a derived per-person "net owed" number that needs no data
entry, AND the ability to mark specific transfers as real tracked loans.

## Goals

- Per contact, surface **two numbers side by side**: raw net transfer flow (auto)
  and tracked-loan balance (only marked loans). The gap is visible and closeable.
- Let the user mark individual outflow transfers as loans (tracked Reimbursements)
  right where they see the transfers.
- Mixed currencies shown **per-currency**, no FX conversion (matches how
  reimbursements already work).

## Non-goals

- No auto-guessing which transfers are loans — the user marks them.
- No change to the dashboard tile's period-scoping. The ledger page is the
  all-time home; the dashboard tile remains a period-scoped flow and will populate
  as loans are marked.
- No changes to `txn_type` or transaction amounts. The link pass only sets the
  counterparty FK.

## Primitives framing (no spine change)

- "Loan to a friend" = an **Expectation** — a `Reimbursement` row created from the
  outflow transfer. Existing status machine (`expected → received | overdue |
  waived`). No new primitive.
- "Net owed per person" = a **derived view** over linked transfers + Reimbursements.
  No new table.
- Counterparty = existing **Contact**.

## Components

### 1. Contact match-terms

Add optional `aliases` (comma-separated string) to the `Contact` model + a
migration. Matching rule: a transfer belongs to a contact when its lowercased
merchant text (`merchant_clean` ∥ `merchant_raw`) contains the contact's
`normalizedName` OR any alias term. The user controls false positives by editing
the alias list (e.g. Caelan → `caelan, iten-mcgrath`).

- Pure matcher helper, unit-tested: `(terms, merchantText) → boolean`.
- Backend `PATCH /api/contacts/:id` accepts `aliases`.
- Frontend Contact edit surface exposes the field.

### 2. Extended link pass

Generalize the existing #376 counterparty backfill
(`backend/src/routes/transactions.ts` `counterparty/backfill`) to also read
`merchant_raw`/`merchant_clean`, not only `counterparty_raw`.

- Scope: txns with `counterparty_contact_id IS NULL` that are person-to-person
  flows — `txn_type='transfer'` or merchant text matching an e-transfer pattern
  (e.g. `e-?transfer`, `online transfer`). Excludes investment-account rows.
- For each, match against every contact's terms (Component 1). Single unambiguous
  match → auto-linked on commit. Ambiguous (matches >1 contact) → NOT auto-linked;
  surfaced as a manual-pick queue (the row + its candidate contacts) so the user
  resolves each one. Never silently dropped.
- **Dry-run preview** endpoint returns, per contact, the unambiguous candidate
  count + a sample, AND the ambiguous rows with their competing contacts. Writes
  nothing.
- **Commit** sets `counterparty_contact_id` on unambiguous matches. Idempotent —
  never relinks an already-linked row. Reuses the existing rate-limit / streaming
  shape.
- **Manual resolve:** an endpoint to set `counterparty_contact_id` on a single
  ambiguous row to the user-chosen contact (reuses the existing per-transaction
  counterparty-link path). The ledger-page UI presents the ambiguous queue.

### 3. Ledger derivation

New endpoint `GET /api/contacts/:id/ledger`. Returns, per currency:

- `rawNet`: sum over linked transfers of (sent − received). Sent = negative-amount
  transfers (money out to the contact), received = positive-amount transfers.
- `trackedBalance`: outstanding reimbursements for that contact, reusing
  `summarize()` (`backend/src/reimbursements/serialize.ts`).
- `transfers[]`: the linked transfer rows (id, date, amount, currency, merchant,
  direction, whether already marked as a loan).

Pure aggregator helper, unit-tested, separate from the route.

### 4. Per-person ledger page (frontend)

- **Landing:** list of person-contacts, each showing `rawNet` and `trackedBalance`
  per currency and the gap.
- **Drill-in:** one contact's transfer rows. Each **outflow** row has a
  "mark as loan" action → creates a Reimbursement via the existing
  `POST /api/transactions/:id/reimbursable`. Each **inflow** row can be linked as a
  repayment via the existing match / `link-repayment` flow.
- Built on design-system primitives (no raw inline styles / legacy App.css).

### 5. Dashboard

No logic change. As loans are marked, the existing `owedBack` tile populates
(period-scoped, by design).

## Data flow

1. User sets aliases on Caelan / Stephen (Component 1).
2. Runs the link pass: preview shows N candidate matches per contact → commit
   (Component 2). Transfers become FK-linked.
3. Ledger page shows raw net + transfer rows + tracked balance (Components 3, 4).
4. User marks the real loan outflows → tracked balance grows, the gap shrinks.
5. Dashboard `owedBack` tile reflects in-window marked loans (Component 5).

## Testing

- **Unit:** alias matcher (term → merchant text, including the
  "Caelan" vs "CAELAN ANTHONY ITEN-MCGRATH" case); net-flow aggregator
  (sent − received per currency, mixed CAD/USD, no FX); reuse of `summarize()` for
  tracked balance.
- **Link pass:** dry-run returns candidates and writes nothing; commit sets the FK
  idempotently, skips already-linked rows, auto-links unambiguous matches, and
  leaves ambiguous (>1 contact) rows unlinked but reported in the manual-pick
  queue; manual-resolve sets the chosen contact on one ambiguous row.
- **Integration:** ledger endpoint returns both numbers for a contact with mixed
  transfers plus one marked loan.
