# Partner-net sign fix — design

- **Date:** 2026-06-02
- **Branch:** claude/adoring-hermann-59d8a0

## Problem

The partner-split **Net** on the Reports page — and the **Partner Fairness**
dashboard — shows the wrong direction. An expense you paid that is the
partner's share displays as *"you owe partner"* instead of *"partner owes you."*

Confirmed on prod 2026-06-02 (contact "Dad", id 3): flipping his two
transactions to 100% his share produced a red **−$11,838.86 "you owe partner"** —
the opposite of reality (Connor paid; Dad owes Connor).

## Root cause

A sign-convention mismatch:

- `splitAmount` (`backend/src/import/calculateShares.ts`) stores
  `my_share_amount` / `partner_share_amount` as the **raw signed amount** →
  purchases are **negative**.
- The owed-balance interpretation treats **positive** partner-share as
  "partner owes me":
  - `partnerMath.rawNetForRow` returns `sumPartner` (positive ⇒ `partner_owes_me`).
  - `partnerFairness.buildFairnessByCurrency`:
    `balance = partnerShareTotal + (iPaid − partnerPaid)`.
- So a real (negative) purchase share flows through as a **negative** net ⇒
  *"you owe partner."*

The unit tests pass only because they feed **abstract positive** `sumPartner`,
never real negative-purchase data through split → sum → net.

Corroboration that "negative = spend" is the true data convention, and that
negating is the correct fix:

- `partnerFairness.youCovered = max(0, −myShareTotal)` negates `myShare` to get
  a positive out-of-pocket figure (assumes shares are negative for purchases).
- `queryBuilders.executePartnerBalance` (the AI path) **already negates**:
  `acc.net += −partnerShareAmount`, `net > 0 ⇒ partner_owes_me`. It is already
  correct and serves as the reference implementation.

## Chosen approach (A): negate at the interpretation layer

Keep share columns as raw signed spend (no data migration). Fix the two
out-of-sync owed-balance computations to match the already-correct AI path.

### Changes

**1. `backend/src/summary/partnerMath.ts`**

- `rawNetForRow(r)`: return `−sumPartner` (0 when null/0). Update the doc
  comment: *net = what the partner owes me = negation of their signed
  share-sum, because spend is stored negative.*
- `applySettlements`: **unchanged**. Re-verified `net = rawNet + (iPaid −
  partnerPaid)`; `partner_paid_me` lowers the balance, `i_paid_partner` raises
  it. This holds under the negated `rawNet` (e.g. gross +640.56, `partner_paid_me`
  640.56 ⇒ 0 "even").

**2. `backend/src/summary/partnerFairness.ts`**

- `buildFairnessByCurrency`:
  `balance = −partnerShareTotal + (settlement.iPaid − settlement.partnerPaid)`.
- `buildFairnessMonthly`: `netDelta = −acc.partnerShare + acc.settlementDelta`;
  `cumulativeBalance` inherits.
- `buildSettlementRecommendation`: unchanged (reads `balance`).
- **Unchanged** (spend figures, not the owed balance): `youCovered`,
  `partnerCovered`, `sharedSpendTotal`, `myShareTotal`, `partnerShareTotal`,
  `currentMonthSharedSpend`, `partnerInflows` / `nonPartnerInflows`, category
  and largest-transaction breakdowns.

**3. Tests — rewrite to the corrected convention with realistic signed inputs**

- `backend/test/partnerNet.test.ts`:
  - Purchase the partner shares: `sumPartner = −640.56` ⇒ `net = +640.56`,
    `partner_owes_me`.
  - Refund / inflow: `sumPartner = +250` ⇒ `net = −250`, `i_owe_partner`.
  - Settlement cases: same semantics, re-derive expected numbers under the
    negated `rawNet`.
  - **May 2026 regression flips:** me-owned row `sumPartner = −7,273.64` now ⇒
    `net = +7,273.64`, `partner_owes_me` (it was purchase-dominated; the old
    test mislabeled it as refund debt). Update the comment.
- `backend/test/partnerFairness.test.ts`: update `balance` / `direction` /
  `netDelta` / `cumulativeBalance` / settlement-recommendation expectations to
  the negated convention. Leave spend-total, inflow, and breakdown assertions
  unchanged.
- Frontend (`ReportsPage`, `PartnerFairnessPage.test.tsx`): update any
  hardcoded balance/direction value assertions. No component logic change —
  the UI renders `direction` from the API.

### Out of scope

- `queryBuilders.executePartnerBalance` (already correct).
- `insights.detectSettlementImbalance` (settlement-only; the sign bug does not
  reach it).
- No `splitAmount` / share-column changes; no data migration.
- No consolidation refactor (explicitly deferred).

### Display

Reports' "Partner share" column keeps the raw spend sign (e.g. −$640.56) while
"Net" shows the owed balance (+$640.56, "partner owes you"). Accepted in review
— share = spend portion, Net = what's owed. Revisit only if confusing in use.

## Data correction (the original request)

After the code fix is merged and verified, on prod (Railway Postgres, via
`railway run --service Postgres -- bash -lc 'psql "$DATABASE_PUBLIC_URL" …'`):

1. Flip Dad's transactions **2886 (NORTHVUE GLASS)** and **2691 (CTRE MEDICAL)**
   to `split_override='partner'`, `final_split_type='partner'`,
   `my_share_amount=0`, `partner_share_amount=amount`. (Same as the earlier
   guarded UPDATE; rollback pre-image is `/tmp/cf_dad_ROLLBACK.sql`.)
2. Insert one `partner_settlements` row: `contact_id=3`, `currency='CAD'`,
   `direction='partner_paid_me'`, `amount=11198.30`, `settled_date='2024-11-21'`.
   - Date rationale: Connor doesn't recall the real payback date; pairing the
     settlement with NORTHVUE's transaction date keeps both inside the same
     report date-window so the net is consistent across filters. Adjustable if
     the real date surfaces.
3. Expected result: Dad's CAD balance = **+$640.56 "Dad owes you"**
   (gross 11,838.86 owed − 11,198.30 settled). CTRE outstanding, NORTHVUE zeroed.

## Verification

- `cd backend && npm test` — unit (`partnerNet`, `partnerFairness`) and
  integration (summary `/partner`, partner fairness route).
- Frontend tests for `ReportsPage` / `PartnerFairnessPage`.
- Post-data-correction prod check: Dad's row reads **+$640.56 "partner owes you."**
