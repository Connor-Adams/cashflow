# Duplicate Detection and Supersession — retroactively, without deleting anything

**Date:** 2026-09-28
**Status:** Design; not yet implemented
**Type:** Data integrity, backend
**Part:** 1b of 6

## Problem

25+ pairs share `(account_id, date, amount)` in 2026 alone.

| Account | Pairs | Impact |
|---|---|---|
| 13 corp Investing | 2764/3329 (+7,348.18), 2767/3330 (+7,000), 2746/3321 (+7,500), 2757/3322 (+7,000) | **$28,848.18 phantom corp inflow** |
| 14 personal WS Chequing | 12 pairs, Feb–Mar | from two re-imports of the same statements |
| 16 corp Save | 971/12178 (−2,000 ×2, same linked counterpart) | derived balance of **−1,996.79 on a savings account** |
| 1 Amex Reserve | 11748/11559 (−20.73 RAILWAY) | inflates the business-expense total feeding L13500 |

Several personal legs point at the **same** `linked_transaction_id` (2863/3315 →
5499, 2846/3302 → 5507, 2848/3304 → 5509). Two legs sharing one counterpart is
structurally invalid, and that is what makes a confident auto-merge rule possible.

### Why the existing dedup did not catch them

`dedupExisting.ts:136,161-185` already queries **all** existing rows in the account
by `sourceIdentityFingerprint` — it is genuinely cross-batch, at import time. So
these pairs exist because the two runs produced **different fingerprints for the
same row**. That file documents the cause class itself:

> the identity fingerprint hashes `merchantRaw`: any change to a parser's text
> output (a fixed line wrap, a new normalisation rule, a reworded memo) gives every
> previously imported row a "new" fingerprint, so the tiers below find no candidates
> at all and a re-import inserts duplicates.

Wealthsimple relabels descriptions between statement cycles. So the honest
expectation is that **this is not fully preventable** for sources without a stable
`sourceReference`, and a retroactive detector is a permanent need rather than a
one-off cleanup. This spec therefore does not promise to eliminate the divergence —
it promises to detect its consequences repeatedly and cheaply.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Auto-merge | Only when **structurally certain** (below) | Connor's call: auto-merge where clear, review otherwise. |
| Everything else | Review queue | Nothing silently disappears from a financial ledger. |
| Merge mechanism | Mark superseded; never `DELETE` | Reversible, auditable, and a rollback stays coherent. |
| Marker shape | **A column pair** — `superseded_by_transaction_id` + `superseded_at` — not a new `status` value | `Transaction.status` is `pending \| posted \| cleared` with `validate: { isIn: [TRANSACTION_STATUSES] }` (`models/Transaction.ts:180-187`, `transactions/types.ts:1`), and `dedupExisting.promotePending` branches on `status === 'pending'`. A status value also carries no pointer to the surviving row, which the "restore what it found" rollback requirement needs. |
| Exclusion mechanism | **A shared `notSuperseded` where-fragment**, applied explicitly at the sites that must exclude | There is no `defaultScope` on any model (`grep defaultScope models/` → zero hits) and 91 non-test files query `Transaction`. A `defaultScope` is a one-line change with a very large blast radius, and it would also hide superseded rows from the transaction list, which must still show them. |
| Surface | A **module**, plus a script wrapper | Part 3 needs it callable per request as a gap type; part 4 needs it as an operation. A script-only build blocks part 3. |
| Detector scope | Bounded to a period | Part 3 calls it on every T1 request; an unbounded whole-ledger scan there is a latency problem. |

### "Structurally certain" — the auto-merge rule

A pair auto-merges only when **all** hold:

1. Identical `account_id`, `date`, and `amount`.
2. **And** both rows carry the same non-null `linked_transaction_id` — two legs
   cannot share one counterpart, as with 2863/3315 → 5499.
3. Neither row has been manually edited: `business_override` false,
   `tax_treatment_override` null **and** no inherited `Category.taxTreatment` and no
   legacy snake_case `finalCategory` classifying it (the override is only one of
   three classification routes — `buildPersonalFacts.ts:139-147` — so testing the
   override alone would auto-merge a categorised row), `final_split_type` equal to
   its column default (every Transaction has one, `models/Transaction.ts:72`), and
   no receipt joined via `Transaction.hasMany(Receipt, { foreignKey:
   'transaction_id', as: 'receipts' })` (`models/index.ts:507-508`).

**An earlier draft had a second certainty criterion keyed on the `import_batch`
period prefix. It is withdrawn: the prefix is not a period.** Both
`parseStatementFile.ts:500-503` and `runImport.ts:321-325` build the default label
from `new Date()`:

```ts
const importBatch =
  (opts.batchLabel && String(opts.batchLabel).trim()) ||
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')} ${account.shortCode || account.name}`;
```

So `2026-05 WK3DD9X35CAD` means *imported in May*, not *covers May*. Two imports in
the same calendar month produce an identical label, so that duplicate class would be
missed entirely; and only the CSV filename path
(`parseStatementFilename.ts:15`, `CardName_YYYY_MM.csv`) yields a real period, so two
ingest paths emit the same `"<YYYY-MM> <token>"` shape with opposite meanings.

Consequence: **the 12 account-14 pairs go to review, not auto-merge**, unless they
independently satisfy criterion 2. That is the correct outcome — they are the class
the withdrawn criterion would have merged on a false premise.

Explicitly **not** auto-merged: two identical amounts on one day from one import
(the recurring $6.00 RBC monthly fees, equal staking rewards, two genuine $1,000
e-transfers). `fuzzyDedupInvestmentActivity.ts:15-23` reasons about exactly this —
"two legitimate identical activities within the window (recurring buys, equal
staking rewards)" are distinct events.

### What "superseded" excludes

A superseded Transaction is excluded from: every tax computation
(`buildPersonalFacts`, `buildCorpFacts`), derived-balance arithmetic
(`networth/balanceAtDate.ts`, `networth/aggregate.ts`), the classification queue
(`routes/tax.ts:54-63`), and spend and income rollups
(`reporting/cashflowTotals.ts`, `cashflow/safeToSpend.ts`, `budgets/*`).

It **remains** visible in the transaction list, flagged, and remains attached to its
`ImportHistory`.

The implementation plan must enumerate the call sites it edits. The exclusion is the
bulk of this part's work, not an afterthought.

### Rollback

`rollbackImportBatch.ts` must clear `superseded_by_transaction_id` on any row
pointing at a transaction the rollback deletes — otherwise rolling back the batch
that contained the *surviving* row leaves the superseded row pointing at a dead id
and silently excluded forever. This needs a step in `executeRollback`, a line in
`previewRollback`'s impact summary, and a field on `ExecuteRollbackResult`. That file
is 20 KB with a TOCTOU re-preview inside the SQL transaction; this is not a one-liner.

### Primitives check

Duplicate suspicion is **derived** — no table. The supersession marker is two
nullable columns on **Transaction**, an existing primitive. One migration, two
`addColumn` calls, nullable with no default, so no backfill and no table rewrite on
Postgres; a null marker means "not superseded". No new status machine.

## Scope

**In:** a new detector module under `backend/src/import/`, a script wrapper following
`backend/scripts/migrate-ws-deposit-activities.ts`, `models/Transaction.ts`, one
migration, `rollbackImportBatch.ts`, and the enumerated exclusion sites.

**Out:** the fingerprint divergence itself — diagnosed above as largely
unpreventable, and explicitly **not** on this part's critical path. Also out:
clearing Connor's actual 25 pairs (part 4).

## Testing

Backend `node:test` via `tsx`, colocated.

- Auto-merge fires on the shared-`linked_transaction_id` shape (real prod pairs
  2863/3315, 971/12178) and on neither of the ambiguous shapes (two $6.00 RBC fees
  on one day).
- A row classified only by an inherited category, with a null override, is **not**
  auto-merged.
- A superseded row is excluded from `buildPersonalFacts`, from derived-balance
  arithmetic and from the classification queue, and **is** still returned by the
  transaction list.
- Rollback of the batch holding the surviving row clears the dangling
  `superseded_by_transaction_id`.
- The detector is period-bounded: a call for 2026 does not scan 2023.
