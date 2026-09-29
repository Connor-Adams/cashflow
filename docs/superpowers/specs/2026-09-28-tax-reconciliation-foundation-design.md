# Reconciliation Foundation — brokerage cash legs, persisted statement balances, duplicate detection

**Date:** 2026-09-28
**Status:** **SUPERSEDED** — split into three parts after an implementability audit
found that two of its three strands contained steps the codebase cannot perform.
Do not plan from this file. Read instead:

- `2026-09-28-brokerage-cash-legs-design.md` (**1a**) — closes the $15,000; the only
  part 4 blocks on. Extends `wsDepositActivityMigration.ts` with an `activityType`
  allowlist, insert-only handling on opt-in accounts, and an opt-in id set. **Note:** an earlier
  framing of "just widen the account scope" is retracted inside that file as a
  data-loss hazard. The activity FK and its migration are dropped.
- `2026-09-28-duplicate-detection-design.md` (**1b**) — **detect and report only**;
  the supersession half is deferred. The `import_batch` auto-merge criterion is
  withdrawn: that prefix is the import month, not the statement period.
- `2026-09-28-statement-balances-design.md` (**1c**) — **CUT.** Retained only for its
  per-source balance evidence.

Also written since: `2026-09-28-t1-provenance-design.md` (**part 0**, ships first)
and `2026-09-28-instalments-and-forward-view-design.md` (**part 5**).

Retained for the problem statement and the prod evidence, both of which still hold.
**Type:** Import correctness + data integrity, backend
**Part:** 1 — superseded, split into 1a / 1b / 1c — the base the other three rest on

## Problem

Connor's personal T1 "seems low". The engine defects are real but small (spec 2).
The material cause is that the ledger the engine reads is not complete, and
nothing in the system can tell that it isn't.

Three findings, measured against prod on 2026-09-28.

### 1. A brokerage cash movement is recorded on only one side

Routing dispatches on **account kind first, then by code** —
`routeRow(ctx, isDepositAccount)` in `pdf/wealthsimpleBrokerage.ts:479-482` is
`depositRouting(ctx, isDepositAccount) ?? brokerageRouting(ctx)`, and
`depositRouting` returns `null` immediately when `!isDepositAccount` (`:460-464`).
(Two earlier drafts of this spec got this backwards in both directions. The
colocated test comment at `pdfWealthsimpleBrokerage.test.ts:649-650` settles it:
"Routing keys off the account type the caller supplies, not off a code list WS can
rename again.")

On a **deposit** account (WS Cash / Chequing / Save) every row goes through
`DEPOSIT_CODE_TXN_TYPE` (`wealthsimpleActivityCodes.ts:104-126`) into the cash
ledger as `transactions`; the comment at `:94-96` is explicit that "on a deposit
account EVERY row is a cash-ledger event, so this covers the brokerage-taxonomy
codes too".

A **brokerage** account writes `transactions` too — but only for twelve cash codes
(`SPEND`, `DCTFEE`, `OBP`, `CASHBACK`, `GIVEAWAY`, `AFT_IN/OUT`, `P2P_IN/OUT`,
`E_TRFIN/OUT`, `EFT` — `pdf/wealthsimpleBrokerage.ts:239-242,473-482`). Everything
else becomes an `InvestmentActivity` only, and that set includes six codes that
move cash across the account boundary: `TRFIN`/`TRFINTF`/`WIREIN`/`WIREINTF` →
`transfer_in`, `TRFOUT`/`TRFOUTTF` → `transfer_out`, plus `DEP`/`WD`/`WDQ` →
`cash_movement` and `CONT` → `transfer` (`:30-39`).

A brokerage `TRFOUT` is **both** an investment-account event and a cash movement
out of the entity. Only the first is recorded.

The tax engine reads `transactions`. The classification queue
(`backend/src/routes/tax.ts:54-63,72-78`) requires three things: `txnType='transfer'`,
a non-null `linkedTransactionId`, **and** that the linked counterpart belong to a
corp entity. So a draw taken directly out of a brokerage account reaches neither.

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
not a failure: `commitStatementImport.ts:234-238` states outright that
`backend/src/routes/statements.ts:197` is the only `AccountStatement.create` in
the codebase — a manual `POST /api/accounts/:id/statements` path nobody uses.

There *is* a reconciliation mechanism, and it is good: a parser recomputes the
closing balance from opening plus every row it parsed, compares it against the
balance printed on the page, and on a mismatch pushes a `blocking: true`
`parseError`. `backend/src/import/reconciliationGate.ts` then refuses the commit
outright, with a server-side acknowledgement digest so a client cannot
pre-emptively disable the check (the `js/user-controlled-bypass` shape), and stamps
the decision on the `ImportHistory` row.

**But it does not apply to any account in this investigation.** The gate itself
performs no arithmetic — it filters parse errors (`reconciliationGate.ts:50-53`)
and its own comment (`:4-8`) attributes the recomputation to the parsers. The only
parsers that reconcile are RBC: `pdf/rbcBusinessBanking.ts:498,529,534`,
`pdf/rbcPersonalBanking.ts:428,458,463`, and `pdf/rbcCreditLine.ts`. **No
Wealthsimple parser reconciles a balance**, and `backend/src/import/statementTypes.ts`
has no `openingBalance` / `closingBalance` fields at all — so
`commitStatementImport` receives no balances to persist even in principle.

Accounts 13, 14, 16 and 24 — every account in the 2026 owner-draw reconciliation —
are Wealthsimple. None of them has ever had a balance checked.

That changes the size of this work. It is **not** "persist what the gate already
computes". It is: extract opening and closing balances in the Wealthsimple parsers,
add a reconciliation check there so the existing gate has something to act on,
thread the balances through `StatementPreview`, and then persist the
`AccountStatement`.

Consequence of having no anchor: `accounts` has no balance column, so a derived
balance is `opening_balance + SUM(amount)` with nothing to check it against. Corp
account 13's derived balance is 72,726.61 against a 2026-09-16 broker value of
94,267.75. Account 16's derived balance is **−1,996.79 on a savings account** —
structurally impossible, and it went unnoticed for a year not because a check
missed it but because no check runs on that account.

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
(`backend/src/import/fuzzyDedupInvestmentActivity.ts`), and `dedupExisting.ts`
already matches across batches at import time (`:136,161-185`). What neither does
is run **retroactively** over rows already committed.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Brokerage cash legs | Emit a `Transaction` **alongside** the `InvestmentActivity` for cash-movement activity types, linked to it | A `transfer_out` is genuinely two things. Recording one side is what lost the $15k. |
| Which activity types bridge | `transfer_in`, `transfer_out`, **`cash_movement` (`DEP`/`WD`/`WDQ`) and `CONT`** | These six are the codes on the *brokerage* map that move cash across the account boundary (`wealthsimpleActivityCodes.ts:30-39`). Buys, sells, dividends and staking rewards settle *within* the account and have no external leg. An earlier draft covered only the two `transfer_*` codes and would have left `DEP`/`WD` — literally cash movements — still dropping their cash side. |
| Relationship | FK on the Transaction pointing at the source activity | Makes the pairing explicit and lets a rollback take both. A field on an existing primitive — no new table. |
| Bridge row must be linkable | The bridge Transaction is created with `txnType: 'transfer'` and runs through the **same transfer-linking and enrichment path** as an imported row | Otherwise it lands in `transactions` and is still invisible: the classification queue requires `txnType='transfer'` AND a non-null `linkedTransactionId` resolving to a corp entity (`routes/tax.ts:54-63,72-78`). Creating the row without linking it solves nothing. |
| Statement balances | Add balance extraction + reconciliation to the **Wealthsimple parsers**, thread through `StatementPreview`, then persist the `AccountStatement` | The gate exists and works; what is missing is any WS parser producing a balance for it to check. Keeps `routes/statements.ts` as the manual path. |
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
   - the two rows carry **different `import_batch` values whose period prefixes
     differ while the source identifier matches** — `batchLabel` is formatted
     `"<YYYY-MM> <sourceId>"`, as in `2026-05 WK3DD9X35CAD` vs
     `2026-06 WK3DD9X35CAD`. **`ImportHistory` has no statement-period column**
     (`models/ImportHistory.ts:15-51`), so this prefix is the only period signal
     available and parsing it is the mechanism — not a placeholder for one.
3. Neither row has been manually edited. Concretely: `business_override` is false,
   `tax_treatment_override` is null **and** neither an inherited
   `Category.taxTreatment` nor a legacy `finalCategory` classifies the row — the
   override is only one of three classification routes (`buildPersonalFacts.ts:139-147`),
   so testing it alone would auto-merge a categorised row; `final_split_type`
   equals its column default
   (every Transaction has one — `models/Transaction.ts:72` — so "no split" needs
   this predicate, not a null check), and no receipt joins to it via
   `Transaction.hasMany(Receipt, { foreignKey: 'transaction_id', as: 'receipts' })`
   — declared in `models/index.ts:507-508`, not in `models/Transaction.ts`.

**Why the fingerprints did not already catch these.** `dedupExisting.ts:136,161-185`
queries *all* existing rows in the account by `sourceIdentityFingerprint`, at import
time — it is already a cross-batch deduper. So the 25 pairs exist because the two
runs produced **different fingerprints for the same row**. Diagnosing why is part
of this work: a retroactive merge that does not fix the fingerprint divergence will
simply be needed again after the next re-import.

### What "superseded" excludes

Marking a row superseded is meaningless until it is stated what ignores it. A
superseded Transaction is excluded from: `buildPersonalFacts` and every tax
computation, derived-balance arithmetic, the classification queue, and spend and
income rollups. It remains visible in the transaction list (flagged), remains
attached to its `ImportHistory`, and `rollbackImportBatch` must restore the
supersession state it found rather than leaving a merged pair half-reverted.

Everything else goes to review. Explicitly **not** auto-merged: two identical
amounts on one day from one import (the recurring $6.00 RBC monthly fees, equal
staking rewards, two genuine $1,000 e-transfers). These are the cases
`fuzzyDedupInvestmentActivity.ts:15-23` already reasons about — its `excludeIds`
comment notes that "two legitimate identical activities within the window
(recurring buys, equal staking rewards)" are distinct events. The same caution
applies here.

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
`pdf/wealthsimpleActivityCodes.ts`), balance extraction + reconciliation in the
Wealthsimple parsers, `statementTypes.ts` (`openingBalance`/`closingBalance` on
`StatementPreview`), a retroactive duplicate detector, `models/Transaction.ts`
(supersession marker + activity FK), `rollbackImportBatch.ts`, one migration.

**Explicitly in, because the bridge is useless without it:** the bridge Transaction
must reach the transfer-linking path, so the row that pairs with an existing
personal leg is linked rather than merely created.

**Out:** the tax engine (spec 2), the T1 surface (spec 3), actually importing
Connor's missing statements or clearing his 25 pairs (spec 4). No SimpleFIN work —
noted below but not fixed here.

**In, because it is a live data-integrity defect:** `Account.taxStatus` defaults to
`'n_a'` (`models/Account.ts:109-113`), which is inside the tax engine's taxable
allowlist (`buildPersonalFacts.ts:91-93`), and the hook that would correct it
returns early for any non-investment account (`Account.ts:211-215`) and is
registered on `beforeCreate`/`beforeBulkCreate` only — never `beforeUpdate`. Prod
account 46 is **"RBC TFSA" with `account_type='checking'` and `tax_status='n_a'`**,
i.e. a TFSA sitting in the taxable allowlist. It holds no transactions today, so the
impact is nil until that account is imported — at which point its interest lands on
Connor's T1. `inferTaxStatus.ts` maps by name and would have caught it; it was never
consulted because the account type is `checking`.

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
- Rollback: removing the import removes both sides. The FK runs
  Transaction → activity, so an activity-side rollback would otherwise orphan the
  transaction — assert it does not.
- Dedup of a synthesised row: the bridge Transaction has no source row of its own,
  so it needs a deterministic `sourceIdentityFingerprint` derived from the
  activity. Assert that re-import matches it rather than inserting a second.
- A Wealthsimple parser extracts opening and closing balances and pushes a
  `blocking: true` parse error when they do not reconcile;
  `commitStatementImport` then writes an `AccountStatement` carrying them. A
  blocking failure still refuses the commit and writes **nothing**.
- Derived balance vs statement closing balance: equal → no signal; divergent →
  surfaced with the delta, and the balance is **not** rewritten.
- `batchLabel` period-prefix parsing: `"2026-05 WK3DD9X35CAD"` and
  `"2026-06 WK3DD9X35CAD"` are recognised as the same source, different period.
- A superseded row is excluded from `buildPersonalFacts`, from derived-balance
  arithmetic, and from the classification queue, while remaining listable.
- Auto-merge fires on each of the two certain shapes and on neither of the
  ambiguous ones — table-driven, with the real prod pairs (2863/3315, 2764/3329,
  971/12178) and the real false-positive shapes (two $6.00 RBC fees on one day)
  as cases.
- A manually-edited row is never auto-merged.
- Integration (Postgres, `backend/test/integration/`): the full path on a fixture
  reproducing the 2026-01-10 account-13 shape — activity present, transaction
  absent, personal counterpart unlinked — ending with the corp leg created, linked
  to the personal leg, and **present in the classification queue**.

  That is this spec's honest exit condition. An earlier draft asserted the draw
  ends up "visible to `buildPersonalFacts`", which this spec cannot deliver:
  `buildPersonalFacts` is entity-scoped and reaches `nonEligibleDividends` only
  from a *personal* transaction — by `taxTreatmentOverride`, by an inherited
  `Category.taxTreatment`, or by a legacy snake_case `finalCategory`
  (`buildPersonalFacts.ts:139-147,154`). All three routes are personal-side. The bridge row is on the corp side, and
  nothing here classifies either leg — that is a human decision, made through the
  queue, and it belongs to spec 4.

## Relationship to the other specs

1. **Reconciliation foundation** — this spec.
2. **Engine correctness** — independent; may run in parallel.
3. **T1 completeness gate** — consumes this spec's outputs (import coverage,
   balance drift, duplicate counts) as its signals.
4. **2026 data backfill** — needs the brokerage bridge before Connor's missing
   statements can be imported correctly.

Build order: 1, 2, 3, 4.
