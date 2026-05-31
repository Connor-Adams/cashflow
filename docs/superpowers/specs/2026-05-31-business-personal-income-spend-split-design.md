# Split business/personal net-spend into Income + Spend tiles

Date: 2026-05-31

## Problem

The dashboard "Business vs personal" tile shows **net spend** per side:

```
business.netSpend = business.totalSpend - business.totalCredits
```

`totalCredits` accumulates **every** positive (inflow) row routed to the
`'credit'` bucket by `classifyPositiveAmount` — refunds, rewards/cashback,
statement credits, reimbursements, **and `txnType='income'`**
(`classifyTransactionFlow.ts:138-144` routes `income → 'credit'`).

Consequence: any positive row with `finalBusiness=true` subtracts from the
business spend figure. A business that books revenue/income tagged
`finalBusiness=true` shows **negative** "business spend" — net cash-positive
rendered as a negative spend number. Income and spend are two unrelated
quantities mashed into one metric.

This conflation also reaches the headline "net spend", merchant, and account
summaries (income silently reduces them too) — but fixing those is explicitly
**out of scope** here (see Scope).

## Locked decisions

- **Income** = positive rows with `txnType === 'income'` only.
- **Refunds / reimbursements / rewards / cashback / statement credits** = offset
  credits that **net against spend** (they reverse purchases; they are not
  income).
- **Two separate dashboard tiles** (not one tile with two metrics).
- **Tile-scoped**: only the `netSpendByBusiness` aggregate and its single
  frontend consumer change. Headline net-spend, merchant summaries, and account
  summaries stay exactly as they are today (income still nets into them). No
  existing displayed numbers outside the business/personal tile move.

## Backend

### `backend/src/summary/aggregateDashboard.ts`

The per-business allocation loop (~lines 409–433) currently does:

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

Net effect:

- `netSpend` now means **Spend** = gross outflows − offset credits (income
  excluded). This is the value the Spend tile renders.
- `income` (new field) is the value the Income tile renders.
- `totalCredits` for this bucket now holds **offset credits only**.

Income's attribution to the business vs personal side reuses the **existing**
split path (`businessPart`/`personalPart` from the allocation loop) — the same
path already routing income into the business bucket today, which is why the
negative was observed. No new attribution logic; income is simply peeled into a
separate accumulator at the same point.

Type changes:

- Add `income: number` to the `netSpendByBusiness` map value type (~line 108).
- Add `income: 0` to the bucket initializer (~line 418).

`classifyPositiveAmount` / `classifyTransactionFlow.ts` are **not** touched —
changing the global classifier would ripple into headline/merchant/account
aggregates, which is out of scope. The income split is a local `txnType` check
inside the per-business block.

### `backend/src/routes/summary.ts`

`netSpendByBusiness` rows (line ~92) now carry `income`. No new endpoint, no
new query. Existing sort is unchanged.

## Frontend

### `frontend/src/pages/DashboardPage.tsx`

- `BusinessReportRow` type: add `income: number`.
- `businessReportData` memo (~542): accumulate `income` alongside
  `totalSpend` / `totalCredits` / `netSpend`.
- `businessSpotlight` memo (~572): expose per-side `income` and `netSpend`, plus
  income-share and spend-share (computed independently).
- Replace the single "Business vs personal" `<BentoTile>` (~1212–1300) with
  **two** tiles:
  - **Income · business vs personal** — Business `income`, Personal `income`;
    share bar = `businessIncome / (businessIncome + personalIncome)`.
  - **Spend · business vs personal** — Business `netSpend`, Personal `netSpend`;
    share bar = `businessSpend / (businessSpend + personalSpend)`.
- Each tile: per-side value + share % + share bar. Share/bar math clamps to
  `[0, 100]` and guards divide-by-zero.

## Edge cases

- **Spend still negative**: if refunds/offset credits exceed gross spend in a
  filter window (no income involved), the Spend value is legitimately negative.
  Render it honestly; treat the share as 0 with a caption.
- **No business income**: Income tile shows `$0` per side → "No income in
  current filters."
- **Currency**: existing per-row currency filtering + summation preserved
  unchanged in `businessReportData`.

## Tests

Backend (`backend/test`, aggregateDashboard):

- A `finalBusiness=true` income row lands in `income`, **not** in `netSpend`.
- A `finalBusiness=true` refund row nets against `netSpend` (spend goes down),
  does **not** appear in `income`.
- Mixed row set: income, refund, and purchase all on the business side →
  `income`, `netSpend`, and `totalSpend` each correct.
- Refund > gross spend (no income) → `netSpend` negative, `income` = 0.
- Personal side unaffected by business income.

Frontend (`DashboardPage` render test):

- Two tiles render with correct income vs spend values per side.
- Share math correct; clamps on negative spend.
- Empty states ("No income in current filters").

## Primitives spine check

This is a new **view/derivation** over the **Transaction** primitive — an
income-vs-spend slice of the existing `finalBusiness` flag. No new table, no new
status machine; it adds a computed field (`income`) to an existing aggregate and
splits one rendered tile into two. Compliant — **not** a spine change.
