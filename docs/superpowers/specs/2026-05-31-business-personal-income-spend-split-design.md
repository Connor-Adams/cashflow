# Fix business_amount sign bug + split business/personal net-spend into Income + Spend tiles

Date: 2026-05-31

## Background

User reported business spend rendering **negative** on the dashboard.
Investigation on 2026-05-31 (prod query + a deterministic probe over the real
`aggregateDashboard`) established the cause is a **sign double-flip bug**, not
income netting as originally hypothesized.

## Verified root cause (prod)

- `business_amount` is persisted **signed** — same sign as `amount`
  (`backend/src/import/calculateShares.ts:54-57`: `return a`, no `abs`). A
  business expense of −$100 stores `business_amount = −100`.
- `backend/src/import/splitTxnByItems.ts:91` (the no-linked-items branch)
  computes `businessAmount: bizAmt * sign`, treating the already-signed value as
  an unsigned magnitude and re-applying the sign.
- For a no-item business expense (−100): `sign = −1`, `bizAmt = −100` →
  allocation `businessAmount = +100`. In `aggregateDashboard`'s per-business
  block, `businessPart = +100` routes into business **credits** (not spend),
  and `personalPart = amount − businessAmount = −100 − 100 = −200` inflates
  **personal** spend.
- Prod (2026-05-31): all 48 `final_business=true` rows are expenses
  (`amount < 0`), all have `business_amount` negative, and **none** have an
  order link → every one hits the buggy path. The business tile reads
  ≈ **−$10,288** (all credits, ~$0 spend) instead of **+$10,288** spend, and
  personal spend is over-counted by ≈ $20,576.
- **Blast radius is exactly `netSpendByBusiness`.** The only consumer of the
  allocation's `businessAmount` is `aggregateDashboard.ts:410-411`.
  `aggregateMonthly`, `ai/insights.ts`, and `routes/budgets.ts` all call
  `splitTxnByItems` but read only `alloc.amount` / `alloc.category` — unaffected.
  Headline metrics / merchant / account summaries use raw `amount` — unaffected.

The income-netting path (positive `txnType='income'` rows routed to the credit
bucket and subtracted from net spend) is real in code but **does not fire in
prod** — there are zero business income rows. Part 2 handles it as
future-proofing.

## Part 1 — Fix the sign bug

`backend/src/import/splitTxnByItems.ts`, the `usable.length === 0` branch
(~line 85-95). Change line 91 from:

```ts
businessAmount: bizAmt === 0 ? 0 : bizAmt * sign,
```

to:

```ts
businessAmount: bizAmt,
```

`bizAmt` (= `n(txn.businessAmount)`) is already signed to match `amount`, so no
sign re-application is needed. This changes **only negative rows** — positive
rows have `sign = +1`, so their result is unchanged, meaning income attribution
is unaffected. The itemized path (lines 129, 141: `biz * sign` where `biz` is a
positive magnitude derived from `businessUsePercent`) is correct and stays
untouched.

After the fix, the 48 prod business expenses report `totalSpend = 10288`,
`totalCredits = 0`, `netSpend = +10288`; personal spend de-inflates.

No data backfill is required — `business_amount` values are correct; only the
aggregation misread them.

## Part 2 — Income vs Spend split

Built on top of the Part 1 fix (correctly-signed `businessPart`).

### Locked decisions

- **Income** = positive rows with `txnType === 'income'` only.
- **Refunds / reimbursements / rewards / cashback / statement credits** = offset
  credits that **net against spend** (they reverse purchases; not income).
- **Two separate dashboard tiles** (not one tile with two metrics).
- **Tile-scoped**: only the `netSpendByBusiness` aggregate and its single
  frontend consumer change. Headline net-spend, merchant, and account summaries
  are untouched (income still nets into those — deliberately out of scope).
- With zero business income in prod today, the Income tile renders **$0** per
  side until business income is tagged. The Spend tile shows correct
  business-vs-personal spend immediately (post Part 1).

### Backend — `backend/src/summary/aggregateDashboard.ts`

The per-business allocation loop (~lines 409–433) currently:

```ts
if (part < 0 && !nonSpend) {
  business.totalSpend += -part;
} else if (part > 0) {
  business.totalCredits += part;
}
business.netSpend = business.totalSpend - business.totalCredits;
```

Change to peel income into its own accumulator:

```ts
if (part < 0 && !nonSpend) {
  business.totalSpend += -part;            // gross outflow
} else if (part > 0) {
  if (row.txnType === 'income') {
    business.income += part;               // NEW: true earned income
  } else {
    business.totalCredits += part;         // refunds/rewards/reimb = spend offsets
  }
}
business.netSpend = business.totalSpend - business.totalCredits; // income no longer subtracts
```

Net effect: `netSpend` becomes the **Spend** value (gross − offset credits);
new `income` field is the **Income** value; `totalCredits` for this bucket holds
offset credits only.

Type changes:
- Add `income: number` to the `netSpendByBusiness` map value type (~line 108).
- Add `income: 0` to the bucket initializer (~line 418).

`classifyPositiveAmount` / `classifyTransactionFlow.ts` are **not** touched —
changing the global classifier would ripple into headline/merchant/account
aggregates, which is out of scope. The income split is a local `txnType` check
inside the per-business block.

### API — `backend/src/routes/summary.ts`

`netSpendByBusiness` rows (~line 92) now carry `income` automatically
(`Array.from(map.values())`). No new endpoint, no new query.

### Frontend — `frontend/src/pages/DashboardPage.tsx` + new lib

- New pure helper `frontend/src/lib/businessIncomeSpend.ts`: given
  `BusinessReportRow[]` (with `income`) and a currency filter, returns
  `{ income: { business, personal }, spend: { business, personal },
  incomeShare, spendShare }`. Shares clamp to `[0, 100]` and guard
  divide-by-zero. Unit-tested in `businessIncomeSpend.test.ts`.
- `BusinessReportRow` type: add `income: number`.
- Replace the single "Business vs personal" `<BentoTile>` (~1212–1300) with
  **two** tiles, consuming the helper:
  - **Income · business vs personal** — Business `income`, Personal `income`,
    share bar from `incomeShare`.
  - **Spend · business vs personal** — Business `spend` (= row `netSpend`),
    Personal `spend`, share bar from `spendShare`.
- Each tile: per-side value + share % + share bar.

### Edge cases

- **Spend still negative**: if offset credits exceed gross spend in a window
  (no income involved), Spend is legitimately negative. Render honestly; share
  → 0.
- **No business income** (the current prod state): Income tile shows `$0` per
  side → "No income in current filters."
- **Currency**: existing per-row currency filtering + summation preserved.

### Tests

Backend (`backend/test/aggregateDashboard.test.ts`, new — none exists today):
- Regression for Part 1: a `finalBusiness=true` expense with **no** item
  context-link and signed `business_amount` lands in business `totalSpend`
  (not `totalCredits`), and personal spend is **not** inflated.
- Income row (`txnType='income'`, positive) → `income` bucket, not `netSpend`.
- Refund row (positive, non-income) → nets `netSpend` down, not in `income`.
- Refund > gross spend (no income) → `netSpend` negative, `income` = 0.
- Personal side unaffected by business income.

Frontend (`frontend/src/lib/businessIncomeSpend.test.ts`, new):
- Income/spend split per side correct; share math; clamps on negative spend;
  empty (all-zero) input.

## Primitives spine check

Part 1 is a bug fix, no shape change. Part 2 is a new **view/derivation** over
the **Transaction** primitive — an income-vs-spend slice of the existing
`finalBusiness` flag. No new table, no new status machine; it adds a computed
field (`income`) to an existing aggregate and splits one rendered tile into two.
Compliant — **not** a spine change.
