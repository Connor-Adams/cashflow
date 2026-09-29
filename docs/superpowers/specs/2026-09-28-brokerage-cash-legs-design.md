# Brokerage Cash Legs — a cash movement out of a brokerage account reaches the ledger

**Date:** 2026-09-28
**Status:** Design; not yet implemented
**Type:** Import correctness, backend
**Part:** 1a of 7 — the only part that closes the missing $15,000, and the only one part 4 blocks on

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

Its activity-type map (`:48-54`) is close to the set needed — but see the warning
below: this map is a *hint*, not the selection filter.

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

### But it must NOT simply be pointed at brokerage accounts

An earlier draft of this spec said "the work is generalising the account-kind scope,
not building new machinery." **That is wrong, and acting on it would destroy real
investment data.**

Selection is not by `activityType`. It is by absence of a security (`:246`):

```ts
const cashRows = activities.filter((a) => a.securityId == null);
```

`ACTIVITY_TXN_TYPE` is consulted only for a *hint* (`:207`), and an `undefined`
lookup does not exclude the row — `orphanToRow` simply omits the hint. Both shadows
and orphans are then **deleted** (`:376-381`):

```ts
const toDelete = [...shadows.map((s) => s.activityId), ...orphans.map((o) => o.activityId)];
await InvestmentActivity.destroy({ where: { id: { [Op.in]: toDelete } } });
```

On a brokerage account that converts and destroys every security-less `fee`,
`interest`, `other`, `split` and `unmapped` row — **including any `buy` or `sell`
whose security failed to resolve**, which is reachable: `pdf/wsActivityStatement.ts`
attaches a security only when the description opens with a ticker, and
`commitStatementImport.ts:156` stores `securityId: security?.id ?? null`.

The existing code guards against exactly this, and it is the guard the earlier draft
proposed to relax (`:111-117`):

```ts
const wrong = accounts.filter((a) => !DEPOSIT_ACCOUNT_TYPES.has(String(a.accountType)));
if (wrong.length > 0) {
  // Refuse rather than silently skip: this cleanup deletes rows, and running
  // it against a brokerage account would be a request to destroy real
  // investment activity.
```

That comment is correct and was written by someone who had thought about this.

So the work is: **add an explicit `activityType` allowlist to the selection, narrow
the delete to rows that allowlist matched, give each run its own batch label, and
only then widen the account guard.** That is new machinery — small, but real.

### Rollback is currently incoherent for converted rows

Two defects, both of which this part must fix before widening anything:

1. The converter **deletes the source activity** (`:379`), so after a rollback of the
   converted transaction the event exists nowhere and the $15,000 hole reopens.
2. The batch label is a shared constant (`:311`):
   ```ts
   importBatch: 'WS deposit ledger cleanup',
   ```
   and `rollbackImportBatch` deletes purely by that string. So rolling back one
   account's cleanup deletes **every converted transaction across all accounts and
   all runs**.

Fix: a per-run, per-account batch label, and either retain the source activity
(marking it converted) or make rollback restore it.

### The forward fix has prior art too

`pdf/questrade.ts:409-422` already emits the cash-side mirror transaction for
`cash_movement` and `transfer` activities. That is the pattern to copy for
`importWsActivityStatement.ts:92`.

It also means the generalised converter must **never be run against a Questrade
account** — those mirrors already exist, so it would classify them as shadows and
delete the activities.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Mechanism | Extend `wsDepositActivityMigration.ts` — allowlist, narrowed delete, per-run batch label, then widen the account guard | It is the house pattern and already handles orphan/shadow pairing, provenance, fingerprints and idempotence. But it selects on `securityId == null` and deletes what it converts, so widening the guard alone destroys investment data. |
| Selection | An explicit `activityType` allowlist — `transfer_in`, `transfer_out`, `cash_movement` — **in addition to** `securityId == null` | Selection today is `securityId == null` only. On a deposit account that is safe because every row is cash; on a brokerage account it is not. |
| The delete | Narrowed to rows the allowlist matched | Otherwise a security-less `buy` is converted and its activity destroyed. |
| Batch label | Per run and per account | `'WS deposit ledger cleanup'` is a shared constant and rollback deletes by batch label. |
| No activity→transaction FK | **Dropped** | It was proposed to make a rollback take both sides, but `rollbackImportBatch.ts` destroys `InvestmentActivity` (`:379-388`) *before* `Transaction` (`:465`), so a real `references` FK would raise a constraint violation on Postgres unless `ON DELETE SET NULL`. The existing migration needs no FK: pairing is by `(accountId, date, amount, currency)`. Dropping it removes the migration from this part entirely. |
| Keying | On `activityType`, not on statement codes | `models/InvestmentActivity.ts` has **no code column** — the declared fields are `activityType, tradeDate, description, quantity, price, amount, fees, splitRatio, currency, sourceReference, sourceRowFingerprint, importBatch`. A code-based rule could only live in the parser, which never sees the activity-statement path where the draw was lost. |
| The bare `transfer` activityType | **Excluded** from the allowlist | `rbcInvestment.ts:305` and `questrade.ts:246,251,258` emit it; `wsActivityStatement.ts` does **not**. `transfer_in`/`transfer_out`/`cash_movement` are unambiguous cash crossings; a bare `transfer` is not. (An earlier draft titled this row "`CONT` scope" — `CONT` is a statement *code*, and this spec's own next row establishes there is no code column on `InvestmentActivity`.) `interest` is also excluded here: it is income, not a cash crossing, and conflating them is how a tax line gets double-counted. |
| Questrade accounts | **Never** run the converter against one | `pdf/questrade.ts:409-422` already emits the cash mirror, so the converter would see shadows and delete the activities. |
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
- `cash_movement`, `transfer_in` and `transfer_out` are converted; `buy`, `sell`,
  `dividend`, `staking_reward`, `interest`, `fee`, `split`, `other` and a bare
  `transfer` are not.
- **A security-less `buy` or `sell` is neither converted nor deleted.** This is the
  data-destruction regression guard and the most important test in this part.
- Rolling back one account's conversion leaves other accounts' converted rows intact
  — the per-run batch label holds.
- Running against a Questrade account is refused.
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

Build order: **0 → 1a → 4 (steps 1, 2, 7) → 2 → 3 → 1b → 5**. Part 1c is **cut**.
