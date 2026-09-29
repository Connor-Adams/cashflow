# Reconciliation Foundation — brokerage cash legs, persisted statement balances, duplicate detection

**Date:** 2026-09-28
**Status:** Design; not yet implemented
**Type:** Import correctness + data integrity, backend
**Part:** 1 of 4 — the base the other three rest on

## Problem

Connor's personal T1 "seems low". The engine defects are real but small (spec 2).
The material cause is that the ledger the engine reads is not complete, and
nothing in the system can tell that it isn't.

Three findings, measured against prod on 2026-09-28.

### 1. A brokerage cash movement is recorded on only one side

`backend/src/import/pdf/wealthsimpleActivityCodes.ts` draws a hard line by
account kind. **Deposit** accounts (WS Cash / Chequing / Save) route every row
through `DEPOSIT_CODE_TXN_TYPE` (`:104-125`) into the cash ledger as
`transactions` — the comment at `:93-95` is explicit that "on a deposit account
EVERY row is a cash-ledger event, so this covers the brokerage-taxonomy codes
too". **Brokerage** accounts route rows into `investment_activities`, where
`TRFIN`/`TRFINTF`/`WIREIN` → `transfer_in` and `TRFOUT`/`TRFOUTTF` →
`transfer_out` (`:34-39`).

A brokerage `TRFOUT` is **both** an investment-account event and a cash movement
out of the entity. Only the first is recorded.

The tax engine reads `transactions`. The classification queue
(`backend/src/routes/tax.ts:27`) requires `linked_transaction_id`. So a draw
taken directly out of a brokerage account reaches neither.

**Confirmed instance:** `investment_activities` id 1634 — account 13 (WS Corporate
Investing), 2026-01-10, `transfer_out`, −15,000.00, "Money transfer out of the
account". Its personal counterpart, transaction 12139 (+15,000.00, same day,
Wealthsimple Chequing, "Money transfer into the account"), **does** exist and sits
unlinked with nothing to pair against. Funded by the 2026-01-02 sells of XEQT
(+7,500.51) and VFV (+7,500.00). Six of the seven 2026 account-13 `transfer_out`
rows have a matching `transactions` row; only this one does not.

That is a real $15,000 non-eligible-dividend owner draw, absent from the tax
engine, with no warning anywhere.

**Do not treat the mechanism as settled.** Account 13 *does* hold 67 transactions
under batches `2026-05 HQ8H0GZ07CAD` (55 rows) and `2026-06 HQ8H0GZ07CAD` (12).
Only the 2026-09 brokerage import (`import_histories` 843 + 851,
`HQ8H0GZ07CAD_2026-07_BROKERAGE.pdf`, 9 rows) wrote activities alone, producing no
`transactions.import_batch` of that name. Establishing *which path changed between
the 2026-06 and 2026-09 runs* is task 1 of implementation, not an assumption to
build on.

### 2. Nothing anchors a balance to reality — and the check already exists

`account_statements` is empty in prod. That is **by design of the current code**,
not a failure: `commitStatementImport.ts:236-238` states outright that
`backend/src/routes/statements.ts:197` is the only `AccountStatement.create` in
the codebase — a manual `POST /api/accounts/:id/statements` path nobody uses.

Meanwhile `backend/src/import/reconciliationGate.ts` **already** recomputes the
closing balance from opening plus every parsed row, compares it to the closing
balance printed on the statement, and refuses the commit on a blocking mismatch.
It is a good piece of work — the refusal carries a server-side digest so a client
cannot pre-emptively disable the check (the `js/user-controlled-bypass` shape), and
the decision is stamped on the `ImportHistory` row.

So the anchor is **already computed at import time and simply never persisted.**
This is a small change, not new machinery.

Consequence of not persisting it: `accounts` has no balance column, so a derived
balance is `opening_balance + SUM(amount)` with nothing to check it against. Corp
account 13's derived balance is 72,726.61 against a 2026-09-16 broker value of
94,267.75. Account 16's derived balance is **−1,996.79 on a savings account** —
structurally impossible, and unnoticed for a year.

### 3. Duplicate rows from re-imported statements

25+ pairs share `(account_id, date, amount)` in 2026 alone.

| Account | Pairs | Impact |
|---|---|---|
| 13 corp Investing | 2764/3329 (+7,348.18), 2767/3330 (+7,000), 2746/3321 (+7,500), 2757/3322 (+7,000) | **$28,848.18 phantom corp inflow** |
| 14 personal WS Chequing | 12 pairs, Feb–Mar | from `2026-05 WK3DD9X35CAD` vs `2026-06 WK3DD9X35CAD` re-imports |
| 16 corp Save | 971/12178 (−2,000 ×2, same linked counterpart) | negative savings balance |
| 1 Amex Reserve | 11748/11559 (−20.73 RAILWAY) | inflates the business-expense total feeding L13500 |

Several personal legs point at the **same** `linked_transaction_id` (2863/3315 →
5499, 2846/3302 → 5507, 2848/3304 → 5509). Two legs sharing one counterpart is
structurally invalid, and that is what makes a confident auto-merge rule possible.

A fuzzy matcher already exists for the activity side
(`backend/src/import/fuzzyDedupInvestmentActivity.ts`) and `dedupExisting.ts`
handles the within-import case. Neither runs across import batches after the fact.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Brokerage cash legs | Emit a `Transaction` **alongside** the `InvestmentActivity` for cash-movement activity types, linked to it | A `transfer_out` is genuinely two things. Recording one side is what lost the $15k. |
| Which activity types bridge | `transfer_in`, `transfer_out` only, in this spec | Buys/sells/dividends settle *within* the account and have no external cash leg. Widening this is a later question, not a quiet default. |
| Relationship | FK on the Transaction pointing at the source activity | Makes the pairing explicit and lets a rollback take both. A field on an existing primitive — no new table. |
| Statement balances | `commitStatementImport` writes the `AccountStatement` row it already reconciled | The gate computes it; persisting is the missing half. Keeps `routes/statements.ts` as the manual path. |
| Balance drift detection | Derived balance vs latest statement closing balance, surfaced — not auto-corrected | A mismatch means an import problem. Silently patching a balance hides it. |
| Duplicate auto-merge | Only when **structurally certain** (definition below) | Connor asked for auto-merge where clear, review otherwise. |
| Everything else | Review queue with a supersession marker | Nothing silently disappears from a financial ledger. |
| Merge mechanism | Mark superseded, never `DELETE` | Reversible, auditable, and a rollback of the owning import stays coherent. |

### "Structurally certain" — the auto-merge rule

A pair auto-merges only when **all** hold:

1. Identical `account_id`, `date`, and `amount`.
2. **And one of:**
   - both rows carry the same non-null `linked_transaction_id` (two legs cannot
     share one counterpart — structurally invalid, as with 2863/3315 → 5499); or
   - the two rows come from **different `import_batch` values whose
     `ImportHistory` rows cover the same account and an overlapping statement
     period** (the `2026-05` vs `2026-06 WK3DD9X35CAD` re-import shape).
3. Neither row has been manually edited — no `business_override`, no
   `tax_treatment_override`, no split, no attached receipt.

Everything else goes to review. Explicitly **not** auto-merged: two identical
amounts on one day from one import (the recurring $6.00 RBC monthly fees, equal
staking rewards, two genuine $1,000 e-transfers). These are the cases
`fuzzyDedupInvestmentActivity.ts:726-733` already reasons about carefully, and the
same caution applies here.

### Primitives check

Per `CLAUDE.md`, before any new model, route or page:

- **Duplicate suspicion** — derived. No table. A supersession marker is a field on
  **Transaction**, an existing primitive.
- **Brokerage cash leg** — a **Transaction**. Already the right primitive; the
  gap is that one is not created.
- **Statement balance** — `AccountStatement` already exists and is already
  modelled. Writing rows to an existing table is not a spine change.
- **Balance drift** — derived from an existing Transaction stream and an existing
  AccountStatement. A computation, not a thing.

No new status machine. No new primitive. No spine change.

## Scope

**In:** `backend/src/import/commitStatementImport.ts`, the Wealthsimple brokerage
path (`importWsActivityStatement.ts`, `pdf/wealthsimpleBrokerage.ts`,
`pdf/wealthsimpleActivityCodes.ts`), `reconciliationGate.ts` (persist, don't
re-derive), a cross-batch duplicate detector, `models/Transaction.ts` (supersession
marker + activity FK), one migration.

**Out:** the tax engine (spec 2), the T1 surface (spec 3), actually importing
Connor's missing statements or clearing his 25 pairs (spec 4). No SimpleFIN work —
noted below but not fixed here.

**Noted, not fixed:** `simplefin_account_links` were created 2026-09-27 23:59; the
two syncs since inserted 0 rows on all six corp accounts, and accounts 28/43/44
have no link at all, so they are permanently manual. Corp account 24 carries a
phantom `opening_balance` of 899.10 with a null `opening_balance_date`, inflating
every derived balance on it. Eight RBC corp inflows totalling +71,976.95 are typed
`unknown` while the same money on account 24 is typed `income`.

## Testing

Backend `node:test` via `tsx`, colocated.

- A brokerage statement containing a `TRFOUT` produces **both** an
  `InvestmentActivity` and a linked `Transaction`; a statement containing only
  buys and sells produces no extra transactions.
- Re-importing the same brokerage statement produces no second transaction
  (the bridge must respect existing dedup, not bypass it).
- A rollback of the import removes both sides.
- `commitStatementImport` writes an `AccountStatement` with the opening and
  closing balances the gate already parsed; a blocking reconciliation failure
  still refuses the commit and writes **nothing**.
- Derived balance vs statement closing balance: equal → no signal; divergent →
  surfaced with the delta, and the balance is **not** rewritten.
- Auto-merge fires on each of the two certain shapes and on neither of the
  ambiguous ones — table-driven, with the real prod pairs (2863/3315, 2764/3329,
  971/12178) and the real false-positive shapes (two $6.00 RBC fees on one day)
  as cases.
- A manually-edited row is never auto-merged.
- Integration (Postgres, `backend/test/integration/`): the full path on a
  fixture reproducing the 2026-01-10 account-13 shape — activity present,
  transaction absent, personal counterpart unlinked — ending with the draw
  visible to `buildPersonalFacts`.

## Relationship to the other specs

1. **Reconciliation foundation** — this spec.
2. **Engine correctness** — independent; may run in parallel.
3. **T1 completeness gate** — consumes this spec's outputs (import coverage,
   balance drift, duplicate counts) as its signals.
4. **2026 data backfill** — needs the brokerage bridge before Connor's missing
   statements can be imported correctly.

Build order: 1, 2, 3, 4.
