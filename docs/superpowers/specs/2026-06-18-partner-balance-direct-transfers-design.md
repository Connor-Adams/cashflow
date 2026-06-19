# Partner balance — fold direct transfers into Partner Fairness

**Date:** 2026-06-18
**Status:** approved (design), pending implementation plan

## Problem

Marking a Contact as the household partner (`is_partner = true`) does not route
their direct money transfers anywhere correct:

1. **People Ledger** still lists the partner as a loan debtor. It excludes only
   `isSelf`, not `isPartner`, so a partner who has sent money shows as a negative
   "you owe them" balance (e.g. Alex: −$8,425).
2. **Partner Fairness ignores the transfers.** `buildFairnessByCurrency` skips
   every row with `partnerShare === 0` (`partnerFairness.ts:335`). A partner's
   "Cash sent"/"Cash received" transfers default to `finalSplitType = 'me'` →
   `partnerShareAmount = 0`, so they are counted in neither the fairness balance
   nor the partner-inflow tally.

Net effect: a partner's transfers are mis-framed as a personal loan and are
absent from the household balance. The money is counted nowhere correct.

## Goal

Fold a partner's **direct transfers** into the existing Partner Fairness
**balance** (period-scoped) so the you↔partner position nets shared-expense
shares and direct cash into one number, and **remove partner contacts from the
People Ledger** loan list.

## Decisions (from brainstorming)

1. **Extend Partner Fairness** (do not build a separate view).
2. **Period-scoped** — use the fairness route's existing `dateFrom`/`dateTo`
   window; no all-time/cumulative balance.
3. **Exclude partner contacts from the People Ledger** loan list (mirrors the
   existing `isSelf` exclusion).
4. Transfers behave as **settlement-equivalent** movements (see sign convention).

## Sign convention

Existing fairness balance: `> 0` → partner owes me, `< 0` → I owe partner.
`balance = −partnerShareTotal + (iPaid − partnerPaid)`.

Direct partner transfers extend it:

- `out` = money **I sent** the partner (`amount < 0` → `Σ |amount|`) → like
  `iPaid` → **+balance** (partner owes me more).
- `in` = money the **partner sent me** (`amount > 0` → `Σ amount`) → like
  `partnerPaid` → **−balance** (reduces what partner owes me).
- New: `balance = −partnerShareTotal + (iPaid − partnerPaid) + (out − in)`.

Example (Alex, this period): `out = 0`, `in = 8425` → balance `−8425`
("I owe partner / she has pre-paid $8,425"), netted with any shared-cost shares.

## Row selection — what counts as a direct partner transfer

A row counts when **both**:
- `counterpartyContactId ∈ partnerContactIds`, and
- `partnerShare === 0`.

The `partnerShare === 0` condition is what separates pure transfers from
shared-expense rows: shared-split rows (`partnerShare !== 0`) stay in the
existing fairness path, so there is **no double-count**. Non-loan categories
(rent/household) are **NOT** excluded here — rent or cash moved between partners
is real settlement money (this intentionally differs from the peer-lending
helper, which excludes them).

## Backend

### Pure helper — `backend/src/summary/partnerFairness.ts`

```ts
export type PartnerTransferTotals = { in: number; out: number };

export function computePartnerTransferDelta(
  rows: SharedTxnRow[],
  partnerContactIds: Set<number>,
): Map<string, PartnerTransferTotals>;
```

Per currency, over rows where `counterpartyContactId ∈ partnerContactIds` and
`partnerShare === 0`: `out += |amount|` for `amount < 0`; `in += amount` for
`amount > 0`. Skip zero/non-finite amounts. Colocated unit tests.

### `buildFairnessByCurrency`

- Accept the per-currency transfer delta via a new optional field on
  `FairnessOptions`: `partnerTransfersByCurrency?: Map<string, PartnerTransferTotals>`
  (keeps the helper pure and the signature backward-compatible).
- Add `(out − in)` to `balance` for each currency (including currencies that
  have transfers but no shared rows — union them in, same as inflows/settlements
  already do).
- Set `partnerTransfers: { in, out }` on each `FairnessByCurrency`.
- `directionFromBalance` and `buildSettlementRecommendation` consume the updated
  `balance` unchanged.

### `buildFairnessMonthly`

Fold the transfer delta into the monthly `netDelta` (`+ (out − in)` per
currency-month) so the trend stays consistent with the headline balance.

### `routes/partner.ts`

`loadSharedTxns` already loads the rows (with `counterpartyContactId`,
`partnerShareAmount`) and `partnerContactIds`. Compute the delta with the new
helper and thread it into `buildFairnessByCurrency` / `buildFairnessMonthly`.

### DTO — `shared/api-types.ts`

Add `partnerTransfers: { in: number; out: number }` to the `FairnessByCurrency`
DTO type.

## Frontend

### Partner Fairness page

Add a line to the balance breakdown showing the direct-transfer contribution,
e.g. "Direct transfers — partner sent you $X · you sent $Y". The headline
balance, direction, and settlement recommendation already reflect the transfers
via `balance`.

### People Ledger — `frontend/src/pages/PeopleLedgerPage.tsx`

- Add `isPartner` to the `ContactLite` interface (the `GET /api/contacts` list
  already returns `isPartner`).
- Change the list filter from `.filter((c) => !c.isSelf)` to
  `.filter((c) => !c.isSelf && !c.isPartner)`. Partner contacts drop out of the
  loan list; their money is handled by Partner Fairness.

## Testing

- **Unit (`computePartnerTransferDelta`):** in/out sign split; rows with
  `partnerShare !== 0` excluded; non-partner counterparties excluded; null
  counterparty excluded; zero amount skipped; multi-currency.
- **Unit (`buildFairnessByCurrency`):** a partner transfer moves `balance` in
  the correct direction and populates `partnerTransfers`; a currency with only
  transfers (no shared rows) still surfaces.
- **Integration (`/api/partner/fairness`):** a partner-tagged transfer nets into
  the returned `balance` and `partnerTransfers`; a non-partner transfer does not.
- **Frontend:** People Ledger hides partner contacts; Partner Fairness renders
  the direct-transfer line.

## Spine note

A derivation over existing `Transaction` data — no new table, no new primitive.
Extends the Partner Fairness view and the Counterparty/partner treatment.

## Out of scope (YAGNI)

- All-time / cumulative partner balance (period-scoped only).
- Auto-creating `PartnerSettlement` records from transfers.
- Changes to the peer-lending helper (`computePeerLending`) shipped in #760.
- Re-categorizing or re-splitting historical transfer transactions.
