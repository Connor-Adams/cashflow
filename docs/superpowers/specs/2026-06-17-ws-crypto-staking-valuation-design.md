# WS Crypto Staking — Valuation + Dual-Write Cleanup

**Date:** 2026-06-17
**Status:** Design (pending implementation)
**Primitives touched:** Transaction (cleanup), Holding / InvestmentActivity (valuation, ACB)

## Problem

The Wealthsimple Crypto account (prod `accounts.id=10`) has two related data-quality
defects, both rooted in how the WS importer handles crypto staking rows.

### Defect 1 — staking rewards carry zero CAD value

WS monthly crypto CSVs emit each staking reward as a CAD/USD **pair**: a CAD-half
row with `amount=0` and a USD-half row carrying the actual dollar value. The
importer drops the USD-half as "zero-value non-CAD noise"
([parseStatementFile.ts:610-612](../../../backend/src/import/parseStatementFile.ts#L610))
**before** mapping, so the value is never captured. Result: 706 `investment_activities`
rows of `activity_type='staking_reward'` carry the coin **quantity** but `amount=0`.

Consequences:
- **Income understated.** [buildPersonalFacts.ts:207](../../../backend/src/tax/builders/buildPersonalFacts.ts#L207)
  routes `staking_reward` into interest income, but `amount=0` → **$0 recognized**.
  CRA treats staking as income at fair market value (FMV) on receipt.
- **ACB understated.** [acb.ts:396](../../../backend/src/portfolio/acb.ts#L396)
  *ignores* `staking_reward` entirely, so reward-acquired coins enter at $0 cost
  basis → future capital gains overstated. This is also the source of the known
  "activity-derived qty < snapshot qty" delta (staking inflows unmodeled).

The original USD value is **unrecoverable** from the DB: dropped pre-map, and
`import_histories` stores only `content_hash` + `file_path_safe`, no raw payload.
→ We reconstruct value from **historical spot price × quantity at `trade_date`**.

### Defect 2 — dual-write produces dead-weight Transaction rows

[parseStatementFile.ts:596-656](../../../backend/src/import/parseStatementFile.ts#L596)
pushes a `Transaction` row for **every** surviving CSV row with **no
account-type guard**; the investment branch ([:664](../../../backend/src/import/parseStatementFile.ts#L664))
adds `InvestmentActivity` rows **additively** on top. So crypto staking events
exist in *both* tables, and the `transactions` copies are `amount=0`.

Acct 10 has **358** such zero-amount transactions — almost entirely
`txn_type` reward (176) + fee (175) + investment (6), plus 1 stray. The account's
real buys/sells carry nonzero CAD amounts and are **not** in this set (purchase=17 /
unknown=19 in the full `txn_type` breakdown are mostly the ~35 nonzero rows). These
zero rows produced the spurious "154 date+amount collisions" dupe flag (every group
collides on `(date, 0.0000)`).

**Verified dead weight** (no reader depends on them): every consumer either filters
`txn_type IN (reward,fee,investment)` or `account_type='investment'` as non-spend
([classifyTransactionFlow.ts `isNonSpend`](../../../backend/src/reporting/classifyTransactionFlow.ts)),
and income/tax/portfolio source from `investment_activities`, not these rows.
Deleting them and halting their creation changes **no** report, tax, budget,
forecast, dashboard, or net-worth number.

The dual-write is **current behavior**, not a pre-fix artifact — re-importing crypto
regenerates the zero rows. So cleanup must fix the write path, then purge.

## Goals

1. Stop creating zero-CAD `Transaction` rows for investment-account imports.
2. Purge the existing 358 dead-weight rows on investment accounts.
3. Value the 673 valuable staking rewards (qty>0) in CAD at FMV on `trade_date`.
4. Recognize that FMV as both **income** and **ACB cost-basis inflow** (CRA-correct).

Non-goals: valuing staking **fees** (182 rows, quantity never parsed — only the
symbol is captured) or `transfer_in` quantities (18 rows). Out of scope; flagged
as follow-up. No change to how current positions are sourced (snapshot-derived).

## Scope (prod, acct 10)

| Item | Count | Notes |
|---|---|---|
| Staking rewards total | 706 | `investment_activities`, `activity_type='staking_reward'` |
| — valuable (qty>0) | 673 | 33 have null/zero qty → skipped |
| Coins to price | 2 | DOT (576 rows), ETH (97 rows) |
| Reward date span | 2024-10-14 → 2026-05-24 | ~19 months daily history |
| Dead-weight transactions | 358 | investment accounts, `amount=0` |
| FX coverage (USD→CAD) | 2021–2026 daily | already present; no FX backfill needed |

## Design

### Component 1 — Import guard (stops the dual-write)

In `parseStatementFile.ts`, before `base.transactions.push(...)`
([:640](../../../backend/src/import/parseStatementFile.ts#L640)), skip the push when
**`account.accountType === 'investment'` AND the parsed CAD `amount === 0`**.

- Narrow predicate by design: kills exactly the in-kind zero rows (reward / fee /
  stake / zero `transfer_in`); real buys/sells (nonzero CAD) still create
  transactions — unchanged behavior.
- `InvestmentActivity` creation is untouched; the value representation is unaffected.
- Rationale (spine): an in-kind investment event with no cash leg is a
  **Holding/InvestmentActivity** event, not a **Transaction**. We are removing a
  fork, not a behavior.

**Test:** unit test in `parseStatementFile.test.ts` — feed a WS crypto monthly
fixture; assert investment-account zero-amount rows yield `InvestmentActivity` but
**no** `Transaction`, while a nonzero buy yields both.

### Component 2 — Purge script

`backend/scripts/purge-investment-zero-transactions.ts`:
- Selects `transactions` WHERE `account.account_type='investment' AND amount=0`.
- `--dry-run` (default) prints count + per-account breakdown; `--commit` deletes in
  a single Sequelize transaction. `--household-id` / `--account-id` scoping.
- **Exact SELECT/DELETE SQL and counts shown to Connor for confirmation before any
  prod write.**

### Component 3 — Historical price backfill

`backend/scripts/backfill-crypto-daily-prices.ts` (or extend existing
[backfill.ts](../../../backend/src/portfolio/backfill.ts)):
- For DOT and ETH securities, call `fetchDailyHistory(ticker, { period1: firstRewardDate })`
  via `enumerateYahooSymbols` (yields `DOT-CAD`/`ETH-CAD`, USD fallback).
- Upsert daily close into `SecurityDailyPrice` (idempotent; existing rows skipped).
- Record the quote currency per bar (CAD direct vs USD-needs-FX).

### Component 4 — Reward valuation backfill

`backend/scripts/backfill-staking-reward-values.ts`:
- For each `investment_activities` row, acct 10, `activity_type='staking_reward'`,
  `quantity>0`, `amount IS NULL OR amount=0`:
  1. Look up `SecurityDailyPrice.close` for the security on `trade_date` (nearest
     prior bar if exact date missing — crypto trades daily, so rare).
  2. If priced in CAD → `closeCad = close`. If USD → `closeCad = close ×
     ensureFxRate('USD','CAD',trade_date).rate`.
  3. Write `amount = round(quantity × closeCad, 4)` and `price = round(closeCad, 8)`
     (per-unit CAD) onto the row.
- Idempotent (re-run overwrites with same inputs), `--dry-run` default, single txn,
  `--verbose` prints each row's computed value. Reports rows it could not value
  (missing price/FX) instead of silently skipping.
- Does **not** recompute `source_row_fingerprint` (fingerprint is over the raw CSV
  row; amount/price are derived enrichments, so re-import dedup is unaffected).

### Component 5 — ACB engine: recognize staking_reward inflows

In `acb.ts`, change the `staking_reward` handling
([:396](../../../backend/src/portfolio/acb.ts#L396)) so a **valued** staking reward
(amount>0, quantity>0) is treated as a **cost-basis inflow**: add `quantity` units
at total cost `amount` to the weighted-average ACB pool (same shape as a `buy`
without fees). Rewards with `amount=0` (unvalued / pre-backfill) remain ignored, so
the engine degrades safely if a price is missing.

Effects (intended): reported crypto ACB rises, realized/unrealized P&L for DOT/ETH
shifts, and activity-derived quantity now reconciles with snapshot quantity.

**Tests:**
- `acb.test.ts` — a buy + a valued staking_reward + a sell; assert weighted-average
  ACB and realized gain match hand-computed values; assert a zero-amount reward is
  still ignored.
- Valuation-math unit test — mock price + FX; assert `amount`/`price` for a CAD-priced
  coin and a USD-priced coin.

## Execution order

1. Component 1 (guard) + Component 2 (purge) — independent of valuation; ship-able
   alone. Purge runs **after** the guard so rows don't regenerate.
2. Component 3 (prices) → Component 4 (valuation) → Component 5 (ACB) — sequential;
   ACB depends on rows being valued.

## Risks

- **Missing/illiquid daily bars** (e.g. an early DOT date). Mitigation: nearest-prior
  bar; valuation script reports any unvalued rows rather than guessing.
- **Yahoo crypto ticker gaps** (some coins lack a `-CAD` pair). Mitigation: USD
  fallback + existing FX series.
- **ACB change alters reported P&L.** Intended, but visible — call it out in the PR;
  it corrects a known understatement.
- **Purge is a prod delete.** Mitigation: dry-run default + explicit SQL confirmation
  gate before `--commit`.
