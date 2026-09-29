# Brokerage Cash Legs — a cash movement out of a brokerage account reaches the ledger

**Date:** 2026-09-28
**Status:** Design; not yet implemented
**Type:** Import correctness, backend
**Part:** 1a of 6 — the only part that closes the missing $15,000, and the only one part 4 blocks on

## Problem

A cash movement on a **brokerage** account is recorded as an `InvestmentActivity`
and never as a `Transaction`. The tax engine reads `transactions`. So a draw taken
directly out of a brokerage account is invisible to it, and invisible to the
classification queue, which requires `linkedTransactionId`.

**Confirmed instance.** `investment_activities` id 1634 — account 13 (WS Corporate
Investing), 2026-01-10, `transfer_out`, −15,000.00, "Money transfer out of the
account". Its personal counterpart, transaction 12139 (+15,000.00, same day,
Wealthsimple Chequing), **does** exist and sits unlinked with nothing to pair
against. Funded by the 2026-01-02 sells of XEQT (+7,500.51) and VFV (+7,500.00).
Six of the seven 2026 account-13 `transfer_out` rows have a matching transaction;
only this one does not.

That is a real $15,000 non-eligible-dividend owner draw, absent from the T1, with no
warning anywhere. At Connor's 2026 income it is worth **$3,042** of tax.

**Where it was lost.** `importWsActivityStatement.ts:92` hardcodes:

```ts
      transactions: [],
      investmentActivities: slice.activities,
```

That is the ongoing Wealthsimple brokerage ingest path. No routing decision is
involved — the preview is constructed with an empty transaction list.

Routing on the *other* brokerage path dispatches on account kind first, then code:
`routeRow(ctx, isDepositAccount)` in `pdf/wealthsimpleBrokerage.ts:479-482` is
`depositRouting(ctx, isDepositAccount) ?? brokerageRouting(ctx)`, and
`depositRouting` returns `null` immediately when `!isDepositAccount` (`:460-464`).
A deposit account sends every row to the cash ledger; a brokerage account sends only
twelve cash codes there (`CASH_TXN_CODES`, `:239-242`) and everything else —
including `TRFOUT` — to `investment_activities`.

## The mechanism already exists

`backend/src/import/wsDepositActivityMigration.ts` is this exact bridge, shipped and
tested, with `backend/scripts/migrate-ws-deposit-activities.ts` as its runner.
`import/cardIdentifierBackfill.ts:40-41` cites it as the house pattern to follow
"rather than inventing a new one".

Its activity-type map (`:48-54`) is precisely the set needed:

```ts
const ACTIVITY_TXN_TYPE: Record<string, TxnType> = {
  cash_movement: 'transfer',
  transfer: 'transfer',
  transfer_in: 'transfer',
  transfer_out: 'transfer',
  interest: 'interest',
};
const DEPOSIT_ACCOUNT_TYPES = new Set(['checking', 'savings']);   // :39
```

It already solves what an earlier draft of this spec listed as open problems:

- **Provenance and fingerprints.** Orphans are inserted *through*
  `commitStatementImport` rather than a raw INSERT, "so they get the same
  enrichment, dedup, fingerprints and ImportHistory provenance as any imported row".
  There is no need to invent a fingerprint for a synthesised row.
- **Pairing.** On `(accountId, date, amount, currency)`, 1:1 by position,
  deliberately ignoring merchant text — the whole point is that the two sources word
  the same event differently.
- **Idempotence.** The insert runs before the delete, so a crash mid-run leaves
  converted orphans still present as activities; the next run reclassifies them as
  shadows and deletes them. Re-running is always safe.

So the work is **generalising the account-kind scope**, not building new machinery.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Mechanism | Generalise `wsDepositActivityMigration.ts` to brokerage accounts | It is the house pattern, already handles orphan/shadow pairing, provenance, fingerprints and idempotence. An earlier draft proposed a new import-time emission plus an FK column and discarded all of it. |
| No activity→transaction FK | **Dropped** | It was proposed to make a rollback take both sides, but `rollbackImportBatch.ts` destroys `InvestmentActivity` (`:379-388`) *before* `Transaction` (`:465`), so a real `references` FK would raise a constraint violation on Postgres unless `ON DELETE SET NULL`. The existing migration needs no FK: pairing is by `(accountId, date, amount, currency)`. Dropping it removes the migration from this part entirely. |
| Keying | On `activityType`, not on statement codes | `models/InvestmentActivity.ts` has **no code column** — the declared fields are `activityType, tradeDate, description, quantity, price, amount, fees, splitRatio, currency, sourceReference, sourceRowFingerprint, importBatch`. A code-based rule could only live in the parser, which never sees the activity-statement path where the draw was lost. |
| `CONT` scope | **Excluded** for now | Keying on `activityType` means `transfer` catches Questrade and RBC contributions too (`wealthsimpleInvestParse.ts`, `wsActivityStatement.ts`, `rbcInvestment.ts`, `questrade.ts` all emit it). `transfer_in`/`transfer_out`/`cash_movement` are unambiguous cash crossings; `CONT` is not, and over-capturing here creates phantom transactions. Revisit with evidence. |
| Linkability | **Add a `txnType` input to `enrichTransaction`** | Without this the bridge does not reliably link, and an unlinked bridge row is as invisible as no row. See below. |
| Forward fix as well as retroactive | Both: fix `importWsActivityStatement.ts:92`, and run the generalised converter over history | The retroactive pass recovers the $15,000; the forward fix stops the next one. |

### Why linkability needs a new input

An earlier draft said the bridge row is "created with `txnType: 'transfer'` and runs
through the same transfer-linking path". That does not work.

`enrichTransaction` (`import/enrich.ts:78`) takes **no** txnType input. The
transfer-sibling hunt is gated on the pipeline's own narrative detection
(`enrichment/detectRelationshipsStage.ts:226`):

```ts
if (input.txnType === 'transfer' || input.txnType === 'payment') {
    const sibling = findTransferSibling(input);
```

where that `txnType` comes from `pickTxnType(signals)` inside the pipeline. The
source's authoritative type is applied only *afterwards*, and only to the stored
column (`commitStatementImport.ts:561-562`), while `linkedTransactionId` (`:625`)
comes from enrichment. `wsDepositActivityMigration.ts` itself passes
`txnTypeHint` — documented as "a HINT, so a narrative the detector actually
recognizes still wins" (`:42-44`).

So whether a bridge row links depends on whether its Wealthsimple description
happens to match a regex in `detectTypeStage.ts:57-58`. "Money transfer out of the
account" does match `transfer (?:to|from|in|out)`, which is why this spec's own
$15,000 case would work by luck. A differently-worded row would not.

Threading a caller-supplied `txnType` into `enrichTransaction` so it reaches
`runDetectRelationshipsStage` is therefore in scope. It is also the fix the existing
migration needs and never got.

### Primitives check

Per `CLAUDE.md`: the bridge produces a **Transaction**, an existing primitive.
Nothing new, no new table, no discriminator. With the FK dropped, **no migration**.

## Scope

**In:** `backend/src/import/wsDepositActivityMigration.ts` (generalise the account
scope), `backend/scripts/migrate-ws-deposit-activities.ts` (runner),
`backend/src/import/importWsActivityStatement.ts` (the `transactions: []` forward
fix), `backend/src/import/enrich.ts` + `enrichment/detectRelationshipsStage.ts` (the
`txnType` input), and colocated tests.

**Out:** statement balances (part 1c), duplicate detection (part 1b), the tax engine
(part 2), the T1 surface (part 3), importing Connor's missing statements or
classifying anything (part 4). **No migration, no model change.**

## Testing

Backend `node:test` via `tsx`, colocated; SQLite per-process temp DB.

- A brokerage account with an orphaned `transfer_out` activity produces one
  transaction; a brokerage account with only buys and sells produces none.
- `cash_movement` and `transfer_in` are converted; `buy`, `sell`, `dividend`,
  `staking_reward` and `transfer` are not.
- The converter is idempotent: two runs produce one transaction. A run interrupted
  between insert and delete self-heals on the next run.
- A converted row carries a `sourceIdentityFingerprint` and an `ImportHistory`
  batch, because it went through `commitStatementImport`.
- **Linking, both ways:** a converted row whose description the narrative detector
  recognises links to its sibling; and a converted row whose description it does
  **not** recognise *still* links, because the caller-supplied `txnType` reached
  `detectRelationshipsStage`. The second case is the regression guard for the whole
  point of this part.
- `importWsActivityStatement` no longer returns an empty `transactions` array for a
  slice containing cash-crossing activities.
- Integration (Postgres, `backend/test/integration/`): a fixture reproducing the
  2026-01-10 account-13 shape — activity present, transaction absent, personal
  counterpart 12139 present and unlinked and **typed `transfer`** (a property of the
  existing row the fixture must assert, since the classification queue filters on
  `txnType: 'transfer'` on the personal leg at `routes/tax.ts:54-63`) — ending with
  the corp leg created, linked, and **present in the classification queue**.

  That is the exit condition. Not "visible to `buildPersonalFacts`": that builder
  reaches `nonEligibleDividends` only from a *personal* transaction's treatment,
  category or legacy `finalCategory` (`buildPersonalFacts.ts:139-147,154`), and
  nothing here classifies either leg. Classification is a human decision made
  through the queue, and it belongs to part 4.

## Relationship to the other parts

The original part 1 bundled three strands with different risk profiles. Split:

- **1a Brokerage cash legs** — this part. Smallest, has prior art, closes the
  $15,000, and is the only thing part 4 blocks on.
- **1b Duplicate detection and supersession** — its own migration, a cross-cutting
  exclusion predicate, and an open-ended diagnosis. Exposes the detector as a module
  so part 3 can call it.
- **1c Statement balances** — largest, partly unachievable, and carries a rollout
  hazard that can 422 the very imports part 4 needs. Off the critical path.
- **2 Engine correctness**, **3 Completeness and provenance gate**, **4 Backfill**.

Build order: **1a → 2 → 1b → 3 → 4**, with **1c** parallel and off part 4's path.
