# Statement Balances — anchor a derived balance to a printed one, where that is possible

**Date:** 2026-09-28
**Status:** **CUT** (2026-09-28). Not scheduled. Retained for the per-source balance
evidence, which is the durable finding.

Cut because it cannot detect either anomaly that motivates it. The problem statement
rests on corp account 16's impossible −$1,996.79 and account 13's 72,726.61 against a
94,267.75 broker value — and both are Wealthsimple **brokerage**, which the Decisions
table below puts out of scope, because only WS Chequing prints both balances. As
scoped it anchors accounts 14, 24 and the RBC set, and sees neither account that
justified the work.

It also carries the set's largest rollout hazard: `reconciliationGate` refuses a
commit outright on a blocking parse error, so a check that does not reconcile in
practice would 422 every Wealthsimple import — including the ones part 4 depends on.

Revisit only if Wealthsimple starts printing a balance on the brokerage statement, or
if balance drift becomes a felt problem rather than an inferred one.

**Type:** Import correctness, backend
**Part:** 1c — cut from the build; was "off the critical path"

## Problem

Nothing anchors a balance to reality. `accounts` has no balance column, so a derived
balance is `opening_balance + SUM(amount)` with nothing to check it against. Corp
account 13's derived balance is 72,726.61 against a 2026-09-16 broker value of
94,267.75. Account 16's derived balance is **−1,996.79 on a savings account** —
structurally impossible, and unnoticed for a year.

`account_statements` is empty, by design of the current code:
`commitStatementImport.ts:234-238` states that `routes/statements.ts:197` is the only
`AccountStatement.create` in the codebase — a manual `POST /api/accounts/:id/statements`
path nobody uses.

A reconciliation mechanism does exist and is good: a parser recomputes closing from
opening plus every row it parsed, compares against the printed closing, and pushes a
`blocking: true` parse error; `reconciliationGate.ts` then refuses the commit, with a
server-side acknowledgement digest so a client cannot pre-emptively disable the check,
and stamps the decision on `ImportHistory`.

**But only RBC parsers implement it** (`pdf/rbcBusinessBanking.ts:498,529,534`,
`pdf/rbcPersonalBanking.ts:428,458,463`, `pdf/rbcCreditLine.ts`). The gate itself does
no arithmetic (`reconciliationGate.ts:50-53`); its comment (`:4-8`) attributes the
recomputation to the parsers. And `statementTypes.ts` has no
`openingBalance`/`closingBalance` fields, so `commitStatementImport` receives no
balances to persist even in principle.

## What is actually achievable, per source

This is the finding that moved this work off the critical path. Measured against the
parsers and their fixtures:

| Source | Accounts | Prints opening/closing? |
|---|---|---|
| **WS Chequing monthly** (`pdf/wealthsimpleChequing.ts`) | 14, 24 | **Yes, explicitly.** Fixture `wealthsimpleChequing.test.ts:23-25` carries `'AUG 1 BALANCE   AUG 31 BALANCE'` then `' $10,274.80    $15,802.33'`. |
| **WS brokerage monthly** (`pdf/wealthsimpleBrokerage.ts`) | 13, 16 | **Only a per-row running column, discarded.** `isActivityRow` requires `cols[last]` to be money but the row keeps only `debit`/`credit`. Derivable as `firstRowBalance − firstRowAmount` / `lastRowBalance` — but a statement with no activity then yields nothing. |
| **WS Custom Activity Statement** (`pdf/wsActivityStatement.ts`) | the ongoing brokerage path | **Never.** `grep -in balance` returns zero hits. Columns are Transaction Date, Settlement Date, Transaction, Description, Debit, Credit, Currency. Its own header notes WS retired the per-account statement exports, leaving the holdings report and this. |
| **WS credit card** (`pdf/wealthsimpleCreditCard.ts`) | — | `New balance` only; no opening. |

The third row is the one that matters: it is the ongoing brokerage ingest path — the
one that lost the $15,000 — and **it cannot produce a balance at any effort level.**
An earlier draft's instruction to "add a reconciliation check there" was unachievable.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Sources in scope | **WS Chequing only** | It is the one WS source that prints both balances. The brokerage monthly is derivable-with-effort and fails on a no-activity month; the activity statement is impossible. Attempting all of them is how this part grew large enough to endanger part 4. |
| RBC | Persist the balances RBC parsers **already compute** and currently discard as locals (`rbcBusinessBanking.ts:497-499`) | Two lines, and it populates the table for accounts 28 and the personal RBC set. |
| Brokerage reconciliation | **Out** | On a brokerage account `opening + Σtransactions ≈ closing` is false by construction — only twelve cash codes become transactions. A correct check must sum activities ∪ transactions, per currency (margin accounts split CAD/USD with separate running balances), and breaks on any `unmapped` code. Materially larger and different from the RBC precedent. |
| Rollout | Ship the WS check **non-blocking first** — a plain `parseError`, no `blocking` — measure against real statements, then flip | `reconciliationGate` refuses the commit outright on a blocking error and writes no `ImportHistory`. A check that does not reconcile in practice would **422 every Wealthsimple import**, including the ones part 4 needs. This is the single largest risk in the original part 1. |
| Uniqueness | Add a unique index on `account_statements (account_id, period_start, period_end)` and an `import_history_id` | `models/AccountStatement.ts` has neither, so a re-import would insert a second row and `rollbackImportBatch` would have no way to find and remove one. |
| Both commit paths | The `AccountStatement` write runs on the already-imported short-circuit as well as the commit body | Exactly the reasoning that moved rate-period capture to both paths: "a statement that had once contributed transactions could never be re-imported to pick up a newly-supported field." |
| Balance drift | Surfaced, never auto-corrected | A mismatch means an import problem. Silently patching a balance hides it. |

### Primitives check

`AccountStatement` already exists and is already modelled; writing rows to it is not a
spine change. Balance drift is **derived** from an existing Transaction stream and an
existing AccountStatement — a computation, no table.

## Scope

**In:** `pdf/types.ts` (`PdfParseResult` balance fields), `statementTypes.ts`
(`StatementPreview` balance fields), `pdf/wealthsimpleChequing.ts` (extraction +
non-blocking check), the RBC parsers (surface the locals they already compute),
`commitStatementImport.ts` (persist on both paths), `models/AccountStatement.ts`,
one migration, `rollbackImportBatch.ts`.

The thread is longer than "thread through `StatementPreview`": there is no balance
field anywhere on the pipeline, so it runs `PdfParseResult` → `parseStatementFile` →
`StatementPreview` → `commitStatementImport` → `AccountStatement`.

**Out:** WS brokerage and activity-statement reconciliation (above); any change to
the gate's digest mechanism.

## Testing

- WS Chequing: the summary block is extracted from the real fixture; `opening +
  Σamount ≈ closing` reconciles; a deliberately corrupted fixture raises a
  **non-blocking** parse error and the commit still succeeds.
- The flip to blocking is a separate, later change with its own test.
- `commitStatementImport` writes one `AccountStatement` per statement on a first
  import **and on a re-import** — the unique index holds, no second row.
- Rollback removes the `AccountStatement` it created.
- Derived balance vs statement closing: equal → no signal; divergent → surfaced with
  the delta, and the balance is **not** rewritten.
- Integration (Postgres): the unique index is enforced. SQLite does not enforce
  constraints the same way — `backend/src/db.ts:32` sets only `busy_timeout`, not
  `PRAGMA foreign_keys = ON` — so a unit test would pass regardless.

## Relationship to the other parts

Part 3's "derived balance diverging from the latest statement closing balance" signal
depends on this part, and therefore covers **only accounts whose source prints a
balance**. Part 3 must say so rather than implying whole-ledger coverage.

Build order: **0 → 1a → 4 (steps 1, 2, 7) → 2 → 1b → 3 → 4 (rest) → 5**. Part 1c is **cut**.
