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
`commitStatementImport.ts:157` stores `securityId: security?.id ?? null`.

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

So the work is: **add an explicit `activityType` allowlist to the selection, make
the converter insert-only on opt-in accounts so it removes nothing there, give each
run its own batch label, report shadows, and teach the guard an explicit opt-in id
set.** That is new machinery — small, but real. The `accountType` refusal stays
exactly as it is for every account not named in that set, and deposit-account
handling is untouched throughout.

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

Fix for the second: a per-run, per-account batch label on opt-in accounts.

**The first is fixed by the insert-only decision**, not accepted. Because the
converter removes no activity on an opt-in account, a rollback of the converted
transaction leaves the activity in place and a re-run recreates the transaction.
Deposit accounts keep the shared label, so their existing rollback addressing is
unchanged.

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
| Mechanism | Extend `wsDepositActivityMigration.ts` — conditional allowlist, insert-only on opt-in accounts, per-run batch label, shadow reporting, and an opt-in id set the guard consults | It is the house pattern and already handles orphan/shadow pairing, provenance, fingerprints and idempotence. But it selects on `securityId == null` and deletes what it converts, so widening the guard alone destroys investment data. |
| Selection | An `activityType` allowlist — `transfer_in`, `transfer_out`, `cash_movement` — applied **only to accounts in `BROKERAGE_CASH_LEG_ACCOUNT_IDS`**, in addition to `securityId == null` | Selection today is `securityId == null` only, and on a deposit account that is correct: every row there is a cash-ledger event. Making the allowlist global would stop converting deposit-account `interest`, `fee` and bare `transfer` rows on accounts 14/16/24 — against the 190 shadows and 66 orphans the runner documents (`migrate-ws-deposit-activities.ts:16-17`) — and would break the passing test at `wsDepositActivityMigration.test.ts:192-201`, which asserts an `interest` orphan carries `txnType: 'interest'`. Deposit accounts keep today's behaviour unchanged. |
| Scope of conversion | On an opt-in account, only rows the allowlist matched are converted at all | Keeps a security-less `buy` out of the conversion set entirely. On a deposit account, selection and handling are unchanged. |
| Batch label | Per run and per account, **on opt-in accounts only** | `'WS deposit ledger cleanup'` (`:311`) is a shared constant and `rollbackImportBatch` matches it exactly (`:185,369,466`), so one rollback reaches every converted row ever made. Changing it on deposit accounts too would alter how existing rollbacks address accounts 14/16/24, which contradicts this part's promise that deposit behaviour is unchanged. |
| No activity→transaction FK | **Dropped** | It was proposed to make a rollback take both sides, but `rollbackImportBatch.ts` destroys `InvestmentActivity` (`:379-388`) *before* `Transaction` (`:465`), so a real `references` FK would raise a constraint violation on Postgres unless `ON DELETE SET NULL`. The existing migration needs no FK: pairing is by `(accountId, date, amount, currency)`. Dropping it removes the migration from this part entirely. |
| Keying | On `activityType`, not on statement codes | `models/InvestmentActivity.ts` has **no code column** — the declared fields (`models/InvestmentActivity.ts:15-34`) are `activityType, tradeDate, settlementDate, description, quantity, price, amount, fees, splitRatio, currency, recipientSecurityId, costBasisAllocationPct, cashComponent, sourceReference, sourceRowFingerprint, importBatch`. A code-based rule could only live in the parser, which never sees the activity-statement path where the draw was lost. |
| The bare `transfer` activityType | **Excluded** from the allowlist | `rbcInvestment.ts:305` and `questrade.ts:246,251,258` emit it — and so does the other Wealthsimple brokerage path: `wealthsimpleActivityCodes.ts:30` maps `CONT: 'transfer'`, and `wealthsimpleBrokerage.ts` parses exactly the monthly statements part 4 step 1 re-imports. (`wsActivityStatement.ts` does not emit it; an earlier draft rested the exclusion on that alone, which was the wrong reason for the right call.) `transfer_in`/`transfer_out`/`cash_movement` are unambiguous cash crossings; a bare `transfer` is not. (An earlier draft titled this row "`CONT` scope" — `CONT` is a statement *code*, and this spec's own next row establishes there is no code column on `InvestmentActivity`.) `interest` is also excluded here: it is income, not a cash crossing, and conflating them is how a tax line gets double-counted. |
| Account admission | **An exported `BROKERAGE_CASH_LEG_ACCOUNT_IDS` constant that `loadDepositAccounts` consults**, never a widened `accountType` set | `Account` has no institution, provider or parser field (`models/Account.ts:26-51`), and every brokerage account of every provider is `accountType: 'investment'` (`runImport.ts:804-811` for Wealthsimple, `:999-1003` for Questrade). So widening `DEPOSIT_ACCOUNT_TYPES` to admit account 13 admits **every Questrade account in the household at the same time** — and `questrade.ts:408-423` already emits the cash mirror, so the converter would see shadows and clear real activities. A round-two draft said "widen the account guard"; that rebuilds the round-one hazard one provider over. A round-three draft then said "the runner takes named account ids" — **which is a no-op**: `backend/scripts/migrate-ws-deposit-activities.ts:35,46,67` already accepts `--accounts a,b,c` (default `14,16,24`), and the refusal lives *downstream* of those ids inside `loadDepositAccounts` (`:104-122`), so `--accounts 13` throws today and would still throw. The guard must itself take the opt-in set: `DEPOSIT_ACCOUNT_TYPES.has(type) \|\| BROKERAGE_CASH_LEG_ACCOUNT_IDS.includes(a.id)`. **Both the id list and the `activityType` allowlist are exported constants in this module** — `BROKERAGE_CASH_LEG_ACCOUNT_IDS` and its allowlist — which the runner defaults to and **part 3 imports**, so the two cannot drift — an earlier draft made it a per-invocation CLI argument "never defaulted", which part 3 cannot read: it is a read-path computation with no table, and a shell argument is not queryable. One declaration, two readers, no persistence. |
| Shadow pairing on brokerage | **On an opt-in account, shadows are reported and nothing else.** Orphan conversion runs unattended; deposit accounts are unchanged. | The shadow half is not protected by the allowlist. Pairing is `(accountId, date, amount, currency)` alone (`:100`), justified by an empirical claim measured on deposit accounts: "In prod no such key occurs twice on either side" (`:14-18`). On a brokerage account the transaction table is already populated by the twelve cash codes, so a same-day same-amount collision between an allowlisted `transfer_out` activity and an unrelated `E_TRFOUT` transaction is far likelier. A false shadow match clears a real cash crossing whose event is **not** in the ledger — the exact loss this part exists to stop. And it cannot be settled by a cleverer key: `(date, amount, currency)` genuinely cannot distinguish "the same event, recorded twice" from "two events of the same size on the same day". Where the data cannot decide, a person does. |
| Confirmation surface | **None — `--confirm-shadows` is cut** | It was designed when the converter still removed rows on opt-in accounts, and under insert-only there is nothing for a confirmation to authorise: the only act it could have taken was `InvestmentActivity.destroy`, which no longer happens there. Keeping a flag whose action is undefined is worse than not having one. Shadows appear in the run report; a human reading it is the whole mechanism. |
| What the converter does on an opt-in account | **Inserts only. It never removes an activity there.** Shadows are reported, not swept. | Five successive drafts tried to decide *which* activities are safe to remove, and each fix opened a new hole. The deciding argument is in "Why nothing is removed" below: the two states that must be separated are byte-identical, so no rule can separate them. Removing nothing dissolves the whole class. |
| Deposit accounts | **Entirely unchanged** — existing shadow and orphan handling, existing sweep, existing tests | The 190 shadows and 66 orphans the runner exists for (`migrate-ws-deposit-activities.ts:16-17`) are on accounts 14/16/24, where every row is a cash event and the pairing assumption was measured. Nothing in this part touches that path. |
| The mirror's own `txnType` | **Stamp it as `overrideTxnType`** from the row's `activityType` — `transfer_in`/`transfer_out`/`cash_movement` all map to `transfer` — **on the brokerage mirror path only** | Without it the mirror is typed `'unknown'` (positive) or `'purchase'` (negative), because the allowlisted codes are missing from `CASH_CODE_TXN_TYPE` (`wealthsimpleActivityCodes.ts:71-84`). **Scope matters:** those codes are excluded from `AUTHORITATIVE_CODES` (`:146-148`) *deliberately*, with prod evidence in the comment above it — the same credit-card bill payment carries `WD` on one statement and `AFT_OUT` on another, "38 rows typed `transfer` against 24 typed `payment`". Overriding globally would invert that decision. The stamp applies to the synthesised mirror, whose `activityType` is unambiguous; ordinary statement rows keep `cashTyping`'s hint-vs-override logic (`wealthsimpleBrokerage.ts:300-313`) untouched. |
| What the stamp does **not** fix | **Linking** | `overrideTxnType` is resolved at `commitStatementImport.ts:561-562`, *after* `enrichTransaction` returns at `:523`; `linkedTransactionId` comes from enrichment (`:625`). So the stamp fixes the stored column only. An earlier note claimed it "also makes the mirror link" — it does not. Linking is the row below, and the two are independent. |
| The narrative detector cannot be relied on here | It matches `"Money transfer out of the account"` and **not** `"Money transfer into the account"` | `detectTypeStage.ts:57-58` is `\b(transfer (?:to\|from\|in\|out))\b`; "transfer into" does not match. So the confirmed `transfer_out` case types and links by luck while the symmetric `transfer_in` — activity 1712's shape — does neither. This is why the stamp above is required rather than nice to have. |
| Linkability | **Add a `txnType` input to `enrichTransaction`, fed by `row.overrideTxnType ?? row.txnTypeHint`** — the preview's own resolved type, before enrichment runs | Without this the bridge does not reliably link, and an unlinked bridge row is as invisible as no row. See below. |
| Forward-fix scope | **Unscoped — every Wealthsimple brokerage account**, deliberately, unlike the retroactive converter | The opt-in set exists because the *converter removes rows*; the forward fix only adds a Transaction alongside an activity and removes nothing, so it carries none of that risk. **But these mirrors do reach the personal T1**, contrary to an earlier draft here: `buildPersonalFacts.ts:91-93` gates only the *activity and holdings* feeds by `taxStatus`; transactions are pulled by entity, unfiltered by account (`:104-109`, and the comment above it says so outright). So a chequing→FHSA contribution now has two legs in one entity, and tagging both `fhsa_contribution` would deduct it twice (`:168-170` pushes `cad.abs()`) — while part 2 is simultaneously tightening FHSA room. That is a test, not a reason to scope the fix down; account 15's legs are correct to have. Stating this because the two halves of this part genuinely have different blast radii and an earlier draft left the difference unexplained. Needs its own test — round eight added the fix and no test for it. |
| Forward fix as well as retroactive | Both, and the forward fix covers **two** paths | `importWsActivityStatement.ts:92` hardcodes `transactions: []`. But `brokerageRouting` (`wealthsimpleBrokerage.ts:471-477`) also sends every allowlisted cash crossing to `investment_activities`, and that is the parser for the monthly statements **part 4 step 1 re-imports**. Fixing only the first leaves the very import part 4 performs still dropping cash legs. An earlier draft named only `importWsActivityStatement.ts`. |

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
`runDetectRelationshipsStage` is therefore in scope. **The field is
`row.overrideTxnType ?? row.txnTypeHint`** — whichever the preview carries, resolved
before enrichment. Naming it matters: an implementer who threads `txnTypeHint` alone
leaves the forward-fix mirror unlinked, because the mirror carries an override and not
a hint, and that mirror is exactly the `transfer_in` case this part is about. It is
also the fix the existing migration needs and never got — it passes
`txnTypeHint` (`wsDepositActivityMigration.ts:276`) into a pipeline that never reads
it.

### Why nothing is removed on an opt-in account

`orphanToRow` (`:258-262`) stamps the activity's description onto the transaction as
`merchantRaw`, and `commitStatementImport.ts:601` stores it verbatim, so a
converter-made row is identifiable. That much is easy. The hard case is two genuinely
distinct cash events sharing an account, date, amount, currency **and** the templated
Wealthsimple description — "Money transfer out of the account", the confirmed
instance's own wording.

**No stateless predicate can resolve it.** After one conversion run the database holds
one activity at the key and one converter-labelled transaction with the same
`merchantRaw`. That state is byte-identical whether it arose from (a) two real events
whose second insert collided on `stableIdentityFingerprint`
(`commitStatementImport.ts:479-485`) and was skipped at `:497-500`, or (b) one event
whose run stopped between the insert and the sweep. In (a) the survivor must never be
removed; in (b) it must be. Same state, opposite correct actions.

Earlier drafts tried a label match, then "never remove an orphan whose insert did not
land", then a cap of M, then `N == M`. Each was defeated: the first protected the
wrong row, the second only held for one run, the third swept the survivor a run
later, and the fourth — being unscoped — would have killed the deposit-account sweep
this module exists for and broken two passing tests
(`wsDepositActivityMigration.test.ts:245-255` and `:264-287`).

**So the converter does not remove anything on an opt-in account.** It inserts the
missing Transaction and leaves every activity in place. Consequences, all acceptable:

- The ambiguous group is reported every run until a human looks. Nothing is lost.
- An activity and its mirror coexist permanently. On the personal T1 that is harmless:
  a `transfer_out` activity is not income, and the mirror is a transfer, not income.
  On the corp side it is **not** harmless — see the next section.
- Idempotence is trivial rather than argued: a second run finds the transaction
  already present, dedups the insert, and changes nothing.
- Rollback of a converted row no longer loses the event, because the activity was
  never removed. That retires the "Rollback is currently incoherent" defect above
  rather than accepting it.

The residue worth naming: the import path cannot represent two byte-identical cash
events on one account and day. That is a pre-existing `stableIdentityFingerprint`
limitation this part surfaces, not one it introduces, and out of scope to fix.

### The corp side, which no earlier draft considered

`buildCorpFacts` reads exactly the rows both halves of this part change, and it must
be in scope.

**~~The converter removes `internalCashMoves` inputs.~~ — retired by the insert-only
decision, and recorded because it shaped this section.** It used to read: `buildCorpFacts.ts:75-88`
queries `InvestmentActivity` for `transfer_in`/`transfer_out`/`deposit`/`withdrawal`
on corp accounts and feeds them to `corpPerimeter`'s `claimMatchingCashMove`
(`corpPerimeter.ts:196-207`), which is how a corp chequing outflow is recognised as
an internal move to the brokerage rather than an expense. Those are the very types
this part's allowlist converts and then sweeps — and `corpPerimeter.test.ts:258`
fixtures activity 1634 itself. Once swept, corp rows previously explained that way
fall through to the unmatched-outbound-transfer warning. **That no longer happens:
nothing is removed on an opt-in account, so the feed is intact.** The second hazard
below is the live one.

**An unlinked forward-fix mirror on corp account 13 reads as revenue.** The mirror
for a `transfer_in` is a *positive* transaction on a corp account.
`claimMatchingCashMove` matches on opposite sign (`corpPerimeter.ts:201`), and the
activity is positive too, so it never claims; an unlinked positive row then reaches
`revenue.push(t)` (`:237`) as phantom corporate revenue. The negative direction is
not free either: a `transfer_out` mirror, untyped, reaches `expenses.push` (`:264`)
as a phantom deduction, and typed `transfer` it produces the unmatched-outbound
warning that part 3 promotes to a blocker. The filter covers both directions.

Both are T2-side, which this set otherwise declares out of scope — which is exactly
how an unconsidered regression ships. **In scope for this part: `partitionCorpPerimeter` ignores cash-movement
transactions on investment-type accounts**, whatever their origin. Not "converter-
labelled" — an earlier draft said that and it misses the case it names in the same
breath: a **forward-fix** mirror is emitted by `brokerageRouting` during ordinary
statement import and carries that statement's `importBatch`, not the converter's
per-run label, so a label predicate cannot reach it. And part 4 step 1 schedules
exactly that import for account 13.

**Key it on the activity feed, not on `txnType`.** A draft keyed on
"cash-movement transactions" and that cannot work either: `txnType` is the only field
expressing it, and every allowlisted Wealthsimple code — `TRFIN`, `TRFINTF`,
`WIREIN`, `WIREINTF`, `TRFOUT`, `TRFOUTTF`, `DEP`, `WD`, `WDQ` — is **absent** from
`CASH_CODE_TXN_TYPE` (`wealthsimpleActivityCodes.ts:71-84`). So
`wsPdfCashCodeToTxnType` returns null, no hint reaches the commit, and
`commitStatementImport.ts:561-562` falls through to `'unknown'` for a positive row.
A `txnType === 'transfer'` filter would not catch activity 1712's mirror, which is
the case this section exists for.

The predicate that works keys on the **activity feed**: exclude a transaction on an
investment-type account when an `InvestmentActivity` of an allowlisted type matches
its `(accountId, date, amount, currency)`. That is origin-independent by
construction — a converter mirror and a forward-fix mirror both exist precisely
because such an activity exists — and it needs no `txnType` and no label.

**It does need its own query, and its own type set.** A draft said to reuse
`cashMoves` at `buildCorpFacts.ts:75-83` as a zero-cost key. That is wrong twice
over: that query is `['transfer_in', 'transfer_out', 'deposit', 'withdrawal']`, which
**omits `cash_movement`** — the `DEP`/`WD`/`WDQ` half of this part's allowlist
(`wealthsimpleActivityCodes.ts:31-33`) — while `'deposit'` and `'withdrawal'` are not
members of the `activityType` union at all (`statementTypes.ts:91` has
`cash_movement`). So a `DEP` mirror is positive, escapes the filter, cannot be claimed
by `claimMatchingCashMove` (opposite sign, `corpPerimeter.ts:201`) and reaches
`revenue.push` — the very failure this section exists to prevent, one code family
over. And widening line 79 is **not** free: `internalCashMoves` is derived from the
same array at `:84-88`, so it would also widen the claim feed and move corp totals
for reasons unrelated to this part.

So: a separate lookup over `transfer_in`, `transfer_out`, `cash_movement` on
investment-type corp accounts, leaving `cashMoves` and `internalCashMoves` exactly as
they are.

**The exclusion claims 1:1, and reports a multi-match.** One activity excludes one
transaction, the way `claimMatchingCashMove` (`:196-207`) and `claimTransaction`
already work. A bare match would let a single activity drop every transaction at that
key — and this part elsewhere refuses to *act* on that same
`(accountId, date, amount, currency)` key because brokerage collisions are "far
likelier". Silently dropping a real corp revenue row on a key we decline to act on
elsewhere would be the same mistake with the sign flipped. A surplus is reported.

The filter belongs at `buildCorpFacts.ts:90-101`, the only production call to
`partitionCorpPerimeter`; `accountTypeById` is built at `:66`. An earlier draft said to make `internalCashMoves` read the
converted transactions too, which cannot help: `claimMatchingCashMove` matches on
**opposite sign** (`corpPerimeter.ts:201`), and for activity 1712 — `transfer_in`
**+10,000** into account 13, from part 4's own table — both the activity and its
mirror are +10,000, so no same-sign entry can ever satisfy it. The unclaimed positive
row then reaches `revenue.push` (`:237`) as $10,000 of phantom active business income.
Excluding the mirror sidesteps all of it. Because nothing is removed either, the `internalCashMoves` feed is unchanged — so
**corp totals before and after a conversion run are identical**, and that is one
test. The second is that importing an account-13 statement through the fixed
`brokerageRouting` does not move corp revenue, which the label predicate would have
missed.

### Primitives check

Per `CLAUDE.md`: the bridge produces a **Transaction**, an existing primitive.
Nothing new, no new table, no discriminator. With the FK dropped, **no migration**.

## Scope

**In:** `backend/src/import/wsDepositActivityMigration.ts` — the conditional
`activityType` allowlist, insert-only handling on opt-in accounts, the opt-in-scoped
per-run batch label,
the `BROKERAGE_CASH_LEG_ACCOUNT_IDS` guard lookup, shadow reporting, and a label on
`TxnIndexEntry` with label-preferring `claimTransaction`;
`backend/src/tax/builders/buildCorpFacts.ts` — the perimeter filter; **no change to
`corpPerimeter.ts` itself**, which only ever sees the rows the caller passes it; `backend/src/import/pdf/wealthsimpleBrokerage.ts` — the forward fix for
`brokerageRouting`, which part 4 step 1's monthly statements go through;
`backend/scripts/migrate-ws-deposit-activities.ts` — the shadow report; **`wsDepositActivityMigration.test.ts`**, which has a
currently-passing deposit-account case this part must not break;
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
- **On an opt-in brokerage account:** `cash_movement`, `transfer_in` and
  `transfer_out` are converted; `buy`, `sell`, `dividend`, `staking_reward`,
  `interest`, `fee`, `split`, `other` and a bare `transfer` are not.
- **On a deposit account: behaviour is unchanged.** The existing test at
  `wsDepositActivityMigration.test.ts:192-201` — an `interest` orphan carries
  `txnType: 'interest'` — must still pass untouched. That is the regression guard
  for not breaking what already ships.
- **A security-less `buy` or `sell` is neither converted nor deleted.** This is the
  data-destruction regression guard and the most important test in this part.
- Rolling back one opt-in account's conversion leaves other accounts' converted rows
  intact — the per-run batch label holds. The runner prints that label on completion,
  so the operator can name it.
- Deposit-account rollback addressing is unchanged: those rows keep the shared label.
- Running against an account not in `BROKERAGE_CASH_LEG_ACCOUNT_IDS` is refused by the
  existing `accountType` guard — Questrade included, since every brokerage account
  of every provider is `accountType: 'investment'`.
- **A false shadow match is not acted on:** on an opt-in brokerage account, an
  allowlisted `transfer_out` activity and a same-day, same-amount cash transaction
  are printed in the report and the activity survives. No invocation removes it.
- Deposit-account shadows are still handled unattended — no confirmation step is
  introduced for accounts 14/16/24.
- **Self-heal still works:** a deposit-account run interrupted between insert and sweep, resumed,
  recognises its own prior output by batch-label prefix and pairs with it
  unattended — it is not printed as a candidate.
- **Self-heal wins a collision, both shapes.** With two transactions at one
  `pairKey` on an opt-in account — one carrying the converter's label and matching
  `merchantRaw`, one unrelated with the lower id — the activity claims the matched
  one. And with **two activities** at one `pairKey`, the converter-made transaction
  goes to the activity whose description it carries, not to whichever activity sorts
  first. The unrelated row is left
  alone and, if it pairs with a different activity, reported as a candidate. This is
  the test for the label-preferring `claimTransaction`, which under insert-only
  decides which of two activities counts as already-converted and therefore whose
  description is re-inserted.
- **Nothing is removed on an opt-in account.** After a conversion run the activity
  count on that account is unchanged and the transaction count is up by one. Assert
  it across **three consecutive runs** — single-run assertions are what let four
  earlier versions of this rule through.
- **Deposit accounts are untouched.** The two currently-passing sweep tests —
  `wsDepositActivityMigration.test.ts:245-255` (an orphan becomes a transaction and
  the activity count goes to 0) and `:264-287` (a second run changes nothing,
  `deletedShadows === 0`) — must still pass **unmodified**. Together with
  `:192-201` these are the deposit-side regression guard; an earlier draft named only
  `:192-201`, which contains no sweep at all.
- Two identical activities on an opt-in account produce one transaction and two
  surviving activities, reported every run.
- The forward fix emits a cash Transaction on a brokerage account that is **not** in
  the opt-in set — that scope difference is intended, and this test pins it.
- **A chequing→FHSA transfer pair produces one deduction, not two**, after the
  forward fix puts a mirror on account 11.
- **Corp facts are unchanged by the converter**: `buildCorpFacts` totals for a corp
  account are identical before and after a conversion run.
- **Corp facts are unchanged by the forward fix**: importing an account-13 statement
  after `brokerageRouting` is fixed does not move corp revenue or expenses. Activity
  1712 — `transfer_in` **+10,000** into account 13 — must not become revenue. This is
  the test a converter-label predicate would have passed while still being wrong.
- A row the allowlist rejects on an opt-in account is counted in the runner's
  summary rather than vanishing: it is in neither `shadows`, `orphans` nor
  `skipped` today, since `skipped` is populated only from `securityId != null`
  (`:239-245`).
- The converter is idempotent: two runs produce one transaction. On a **deposit**
  account a run interrupted between insert and sweep self-heals on the next run; on
  an opt-in account there is no sweep to interrupt.
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

Build order: **0 → 1a → 4 (steps 1, 2, 7) → 2 → 1b → 3 → 4 (rest) → 5**. Part 1c is **cut**.
