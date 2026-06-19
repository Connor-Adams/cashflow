# Period-Insight peer-lending figures — design

**Date:** 2026-06-18
**Status:** approved (design), pending implementation plan

## Problem

The dashboard `PeriodInsightBand` shows a "loaned out · comes back to you"
chip driven by `owedBack`, which `computeOwedBack` derives from the
`reimbursements` table plus a `partnerShareAmount` fallback. In production the
`reimbursements` table is **empty**, so the chip never appears — even though the
user actively lends money to people via contact-linked transfers (e.g. ~$25k net
to one contact). The real peer-lending signal lives in the transfer ledger
(`counterpartyContactId`-linked transactions), which the band never reads.

Result: the band silently understates peer lending to ~$0.

## Goal

Surface period-scoped peer lending in `PeriodInsightBand` as **two separate
figures** — money **lent out** and money **received back** within the selected
window — sourced from contact-linked transfers, not the empty `reimbursements`
table.

## Decisions (from brainstorming)

1. **Two figures, not a net.** Show `lent` and `received` separately.
2. **Period-scoped.** Computed strictly over the requested `[dateFrom, dateTo]`
   window — consistent with the band's existing contract (no all-time stock, no
   cross-period comparison). Running all-time outstanding stays on the People
   Ledger page.
3. **Exclude partner contacts.** Transfers to/from `is_partner = true` contacts
   are shared-life money, not loans, and are omitted.
4. **Exclude non-loan categories.** Reuse existing `isNonLoanCategory`
   (rent/household).
5. **Separate from reimbursable `owedBack`.** The existing `owedBack` chip and
   the `realCost = netSpend − owedBack` headline are left untouched. Cash loans
   are transfers, not spend, so they must NOT move "Real spend".

## Data source

Contact-linked transactions already loaded for the window:

- `counterpartyContactId IS NOT NULL`
- date within `[dateFrom, dateTo]` (already enforced by `loadPeriodRows`)
- contact NOT `is_partner`
- `finalCategory` NOT in `NON_LOAN_LEDGER_CATEGORIES` (via `isNonLoanCategory`)

Per currency:

- `lent` = Σ |amount| for rows with `amount < 0`
- `received` = Σ amount for rows with `amount > 0`

## Backend

### Pure helper — `backend/src/summary/periodInsight.ts`

```ts
export type PeerLendingTotals = { lent: number; received: number };

export function computePeerLending(
  rows: PeerLendingRow[],
  partnerContactIds: ReadonlySet<number>,
): Map<string, PeerLendingTotals>;
```

`PeerLendingRow` carries `{ currency, amount, counterpartyContactId, finalCategory }`.
Filtering: skip rows with null `counterpartyContactId`, skip partner contacts,
skip `isNonLoanCategory(finalCategory)`. Split by sign into `lent`/`received`
per currency. Colocated unit test `periodInsight.test.ts`.

### Route — `backend/src/routes/summary.ts` `/period-insight`

- Load partner contact IDs for the household (reuse the pattern already used in
  `routes/partner.ts`).
- Call `computePeerLending(mainRows, partnerContactIds)`.
- Attach `peerLending` per currency in the `byCurrency` assembly loop, defaulting
  to `{ lent: 0, received: 0 }` for currencies with no peer-lending rows.

**Risk to confirm during implementation:** `loadPeriodRows` must select
`counterpartyContactId` and `finalCategory`. If the current select omits either,
extend it (and the `mainRows` row type) so the helper has the fields. Verify
before writing the helper wiring.

### DTO — `shared/api-types.ts`

```ts
export type PeerLending = { lent: number; received: number };

export type PeriodInsightCurrency = {
  // ...existing fields unchanged...
  peerLending: PeerLending;
};
```

## Frontend

### `frontend/src/components/dashboard/PeriodInsightBand.tsx`

Below the Real-spend headline (and the existing reimbursable `owedBack` chip),
render two figures when their value > 0:

- **Lent out** — out tone (`text-negative` / `bg-negative-bg`)
- **Received back** — in tone (`text-positive` / `bg-success-bg`)

Read from `data.peerLending.lent` / `data.peerLending.received`, formatted with
the band's existing `money()` helper. Hidden entirely when both are 0. No change
to `realCost`, `owedBack`, or the "where the money moved" breakdown.

## Testing

- **Unit (`computePeerLending`):** partner exclusion, non-loan-category
  exclusion, sign split (lent vs received), multi-currency, empty input,
  null-counterparty rows skipped.
- **Route:** `/period-insight` response includes `peerLending` with correct
  lent/received over a window containing contact-linked transfers; partner
  transfers excluded.
- **Frontend:** figures render when > 0; hidden when 0; existing owedBack chip
  behavior unchanged.

## Out of scope (YAGNI)

- No change to the empty `reimbursements` table or `computeOwedBack`.
- No all-time outstanding stock in this band (lives on People Ledger).
- No backfill / re-categorization of historical transactions.
- No new endpoint — extends existing `/period-insight`.
