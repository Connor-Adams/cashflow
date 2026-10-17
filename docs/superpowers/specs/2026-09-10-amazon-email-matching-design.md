# Amazon email matching — design

Date: 2026-09-10
Status: proposed

## Problem

Amazon transactions are not itemized. Production, queried 2026-09-10:

| metric | value |
|---|---:|
| Amazon-merchant spend transactions | 111 |
| …with an accepted `TransactionOrderLink` | **0** |
| …with a suggested link only | 15 |
| …with no link at all | 96 |
| Amazon `external_orders` in the corpus | 538 |

Zero Amazon links have ever been accepted, while `costco` (6) and `uber_eats`
(1) have. Item-level category spend, budgets, and the dashboard all read through
`loadItemAllocationContext`, which filters `status='accepted'` — so today every
Amazon transaction decomposes into nothing.

A second, independent complaint: Amazon orders placed on the account but paid
with a card Cashflow does not track show up in the item corpus and inflate
totals. This is large — **291 of 538 orders (54%)** carry a `payment_last4`
belonging to no account.

## Evidence

Every number below comes from production, queried 2026-09-10. Where a matching
rule is proposed, it was validated with a **null test**: the same query re-run
with every transaction amount shifted by a fixed offset. A rule whose null-test
yield approaches its real yield is measuring coincidence, not signal.

### The 60 no-candidate transactions, partitioned by cause

Of the 96 unlinked transactions, 37 have a candidate order within ±$0.50/±7d.
The other 60 were partitioned:

| # | cause | explains | **exclusive** |
|---|---|---:|---:|
| 1 | Order exists, correct total, **no `order_date`** | 30 | **30** |
| 2 | True corpus gap (no order within ±30d at any amount) | 23 | **8** |
| 3 | `amazon_report` total is partial (txn = item subset-sum) | 15 | **9** |
| 4 | Date window too narrow | 4 | **0** |
| 5 | FX / currency mismatch | 0 | 0 |
| 6 | Gift card / multi-tender | 0 | 0 |

Union: 47 of 60. Overlaps: `1 ∩ 2 = 15`, `1 ∩ 3 = 6`, `3 ∩ 4 = 3`, `1 ∩ 4 = 2`.

Half of everything is cause 1: the order is already in the database with the
correct total to the cent, and the ±7d date gate discards it because
`order_date` is empty.

### Why `order_date` is empty

`order_date` is populated on **1 of 141** email-sourced Amazon orders all-time,
and 0 of 44 created in the last 90 days.

Both persist paths map `orderDate: extracted.orderDate` and nothing else
(`scanReceipts.ts:707`, `discoverReceiptSources.ts:219`). And
`extracted.orderDate` is legitimately null: Amazon confirmation and shipping
emails commonly state a *delivery* date ("Arriving Thursday, September 4"), not
an order date, so the AI extractor correctly returns null. The deterministic
`DATE_RE` (`parsers/amazon.ts:55`) cannot match those either — its capture group
is `[A-Za-z]{3,9}\s+[0-9]{1,2},?\s+[0-9]{4}`, which a day-of-week prefix breaks,
and it has no `Ordered on` alternative.

Gmail supplies the answer and it is already fetched:
`GmailMessageSummary.internalDate` (`gmail.ts:80`, ms since epoch) is assigned at
`scanReceipts.ts:561` into `result.internalDate` — **and never used.** Amazon
sends confirmations within minutes of the order, so the email's own date is a
near-exact order date.

### The two email parsers fill disjoint fields

| source | orders | `order_date` | `total` | `payment_last4` |
|---|---:|---:|---:|---:|
| `gmail-scan:ai` | 125 | 0% | 93% | **0%** |
| `gmail-scan:amazon` | 10 | 0% | **0%** | 100% |
| `gmail-discovery:amazon` | 6 | 0% | **0%** | 83% |

`tryDeterministicParse` wins or the AI runs — never both. One parser gets the
money, the other gets the card, neither gets the date.

### The CSV report is a worse total source than the email

Of 75 `vendor_order_id`s present in both `amazon_report` and `gmail-scan:ai`,
**16 have `report_total < gmail_total`** — and in those cases the gmail total
equals the card charge exactly:

| order id | CSV total | email total | card charge |
|---|---:|---:|---:|
| `701-6488283-5477862` | 10.11 | **38.26** | 38.26 |
| `701-3974198-8469065` | 49.69 | **103.78** | 103.78 |
| `701-5875507-6414604` | 22.59 | **90.38** | 90.38 |
| `701-1193033-9686668` | 10.16 | **52.83** | 52.83 |

The CSV row carries a per-shipment partial; the email carries the full order
total. Re-importing the CSV is therefore **not** the fix for post-2026-05-07
coverage — 22 of the 38 post-cutoff unmatched transactions already have a
matching email order, merely undated. True Amazon shipment-splitting accounts
for only 5 of 397 dated orders; cause 3 above is mostly this partial-total
artifact.

### The `last4` signal has never fired

`last4FromText` (`matcher.ts:25`) runs `/\b(\d{4})\b/` over
`txn.notes + txn.sourceReference`. Across the 111 Amazon transactions:
`source_reference` yields **0** matches, `notes` yields 1 — a digit run inside an
item title. `notes` is non-empty on 18 of 111, `source_reference` on 5.

Meanwhile **403 of 538 orders carry `payment_last4`**. The order side is
populated; the transaction side is empty. The join cannot fire.

The card number lives on the *account*. `accounts.short_code` holds it as a
**suffix**, in three formats:

| account | `short_code` | last4 |
|---|---|---|
| Amex Reserve (id 1) | `701001` | 1001 |
| Amex Cobalt (id 40) | `741005` | 1005 |
| RBC Avion Visa (id 17) | `5234` | 5234 |
| Wealthsimple TFSA (id 8) | `HQ6LMLTK8CAD` | — none |

`accounts.bank_account_number` is empty on all 29 accounts. `short_code` already
has precedent as a card identifier: `runImport.ts` matches CSV filename tokens
against it.

### Auto-accept is dead code

`backfillAutoAcceptAmazonLinks` (`backfillAutoAcceptLinks.ts:17`) implements
exactly the right rule and **has zero non-test callers** — no route, no job.
`runAmazonMatching` does auto-accept live (`matcher.ts:235`), and
`upsertSuggestedOrderLink` promotes a still-`suggested` row when re-run. The 15
production links at average confidence 88 are pre-auto-accept rows that were
never re-scanned; `runAmazonMatching` fires only from `routes/amazon.ts:230` and
`routes/capture.ts:128`.

### Ingestion is entirely manual

`backend/src/jobs/` is a complete framework — registry, runner, pg advisory
locks, `cronDefault` with per-row `cronOverride` — with **fourteen** job
definitions including `simplefin_sync` (`0 2 * * *`) and `enrichment_backfill`.

Gmail scan and discovery are reachable **only** via `POST /api/email/scan/google`
and `POST /api/email/discover/google` (`emailIntegrations.ts:159,246`). No cron
job scans email.

Separately: the Chrome MV3 auto-capture extension shipped (`frontend/src/extension/`,
commits `c2fe34a3`, `81deae78`) and has produced **zero rows** — no
`external_orders.source LIKE 'extension%'` exists for any vendor.

## Non-goals

Cut on evidence, recorded so they are not re-proposed:

- **FX conversion in the matcher.** `scoreAmazonOrderMatch` compares raw numbers
  with no conversion, which is a real latent bug — but it explains **0**
  transactions. All 17 USD Amazon orders predate 2019-05-14; all 111
  transactions are 2023-03-16 or later. Zero overlap. Revisit if USD orders
  reappear.
- **Widening the date window.** Explains 4 transactions and **0 exclusively** —
  every one is already covered by cause 1 or 3. Widening 7d→30d buys 2; past 60d
  the null test shows it is noise.
- **Multi-tender / gift-card handling.** `external_order_tenders` holds 7 rows
  across 6 orders, all Costco. Zero Amazon. Untestable.
- **Excluding foreign-card orders from matching.** A foreign order that matches a
  tracked transaction is evidence the ownership resolver is wrong. Surface it
  rather than hide it. Note that Part 2's last4 mismatch penalty is *not* this:
  it is per-pair evidence that two specific cards differ, applied whether or not
  the order is classified foreign, and it never removes an order from the
  candidate pool.
- **A fresh `amazon_report` CSV import.** See above — the CSV's totals are
  partial and the email is the better source.

## Primitives check

Per `docs/superpowers/specs/2026-05-30-cashflow-primitives-design.md`:

- **Card ownership** — a relation between **Account** and **Document**
  (`ExternalOrder` folds into Document). Derived per query, not persisted. No
  new table, no new column.
- **"Foreign" state** — a derived view, not a status machine.
  `TransactionOrderLink.status` already owns the accept/reject machine;
  ownership is orthogonal metadata.
- **Email order fields** (`order_date`, `total`, `payment_last4`) — existing
  columns on an existing primitive. Parser and persistence fix only.

**Zero new primitives. Zero new tables. Zero migrations.**

## Design

Six parts, ordered by measured payoff.

### Part 1 — Email orders get a date *(unlocks 30 transactions)*

**1a. `internalDate` fallback.** Both persist paths take
`extracted.orderDate ?? dateFromInternalDate(summary.internalDate)`.
`dateFromInternalDate` converts ms-since-epoch to a `YYYY-MM-DD` UTC date string.
When the fallback is used, note it in `rawPayload` for debugging.

No `order_date_source` column: nothing branches on the distinction once date-window
widening is cut (see Non-goals), so persisting it would be unused state.

**1b. Exact-cent band in the scorer.** The scoring change that makes undated
orders matchable without new false positives, and the safety net if a message is
no longer retrievable from Gmail.

`scoreAmazonOrderMatch` gains an exact-cent tier *above* the ±$0.50 tier, and
credits it to `secondaryScore`:

```
diff === 0   -> score += 50, secondary += 20, reason 'amount matches to the cent'
diff <= 0.5  -> score += 50
diff <= 2    -> score += 35
else         -> score -= 25
```

This deliberately does **not** raise the primary score. An undated exact-cent
order still totals 65 (50 amount + 15 merchant), which lands in
`selectMatchCandidates`' fallback tier, where the existing tie guard already
does the right thing:

- An exact-cent order and a $0.30-off order both score 65, but only the
  exact-cent one leads on `secondaryScore` → sole leader returned. This is the
  case that currently abstains and loses all 30 transactions.
- Two exact-cent orders both carry `secondary = 20` → `leadersOnSecondary.length
  === 2` → abstain. Correct for the 6 genuinely ambiguous cases.

Raising the primary score instead would push these into the `strong` (≥70) tier,
which returns **all** qualifying candidates and would reintroduce the historical
fan-out. It must stay in the fallback tier.

**Tolerance constraint — not a tunable.** Against the undated pool, exact cents
yields 30 with a null test of `0,0,0,0,0,1,0,0` across eight offsets. At ±$0.50
it yields 45 with a null test of **21–29** — roughly half noise. Undated orders
match on exact cents only. Do not loosen this without re-running the null test.

**1c. Parser merge.** Replace win-or-fallback with a field-wise merge:
deterministic parse first, AI only when the deterministic result is incomplete,
then merge with the deterministic value winning where non-null. Fixes the
disjoint-field profile. The existing daily AI budget cap still applies, and a
complete deterministic parse spends nothing.

**1d. `DATE_RE` fixes.** Allow a day-of-week prefix; add an `Ordered on`
alternative. Cheap, and reduces reliance on 1a.

**1e. Reprocess path.** A `forceReprocess` option on `scanInbox` that bypasses
the `ProcessedEmailMessage` skip (`scanReceipts.ts:472`) for a given message-id
set, so the 141 existing orders are re-parsed against Gmail.

Raw bodies are not retained, but the Gmail message id is — in
`ExternalOrder.rawPayload.gmailMessageId` and `ProcessedEmailMessage.messageId`.
Re-fetching is possible; only the skip is in the way.

`findOrCreate` ignores `defaults` on an existing row, so reprocess needs an
explicit update-on-conflict, not merely a re-run. Update only fields that are
currently null — never overwrite a value a user may have corrected.

**1f. Two bugs found in passing.** `discoverReceiptSources.ts:221-222` hardcodes
`subtotal: null, tax: null` even though the parser returns both. And the AI
`SYSTEM_PROMPT` schema omits `subtotal`/`tax` while `parseExtractedReceipt` reads
`j.subtotal`/`j.tax`, so they are permanently null.

### Part 2 — Account-derived card resolver *(disambiguation + ownership)*

One module, two consumers.

```
resolveAccountLast4(account): string | null
  -> short_code matching /^\d{4,}$/  ->  last 4 digits
  -> otherwise                        ->  null   (Wealthsimple opaque ids)

buildHouseholdLast4Map(householdId): Map<string, Account[]>

classifyOrderCardOwnership(order, map): 'known' | 'foreign' | 'unknown'
  -> payment_last4 null            -> 'unknown'
  -> last4 present in map          -> 'known'
  -> otherwise                     -> 'foreign'
```

**Consumer A — matching.** Replace `last4FromText(txn.notes, txn.sourceReference)`
with the transaction's account last4. This turns a dead signal into a live
discriminator across the 112 known-card orders, and is the only disambiguator
available for the 6 ambiguous exact-cent cases.

Add a **mismatch penalty**: when both sides carry a last4 and they differ,
`score -= 25`. Two different cards is positive evidence against a match, at the
same magnitude as an amount mismatch. Flag for verification against production
before merge — a stale or mis-parsed order last4 would suppress a real match.

**Consumer B — ownership.** As below.

Collision handling: two accounts sharing a last4 still classify as `known`.

**Interaction with Part 1b — must be handled together.** Once the last4 signal is
live, an undated exact-cent order whose last4 matches the transaction's account
scores 50 + 15 + 20 = **85**, which clears `MATCH_CONFIDENCE_THRESHOLD` and lands
in `selectMatchCandidates`' `strong` tier. That tier does `return strong` — it
returns **every** qualifying candidate with no tie guard, because it is written
for the legitimate case of one charge spanning several orders. Two exact-cent
orders on the same card would therefore both be linked: the historical fan-out
shape, reached by a new route.

Part 1b's careful abstention only holds while these orders stay in the fallback
tier. So Part 2 must also add a tie guard to the strong tier: when more than one
candidate ties at the top score, apply the same `secondaryScore` tiebreak used in
the fallback tier, and abstain when it does not produce a sole leader.

This narrows the strong tier's multi-order behaviour to candidates at *different*
scores, which is the case it was actually written for. `runAmazonMatching`'s
auto-accept already requires `candidates.length === 1`, so the blast radius today
is duplicate *suggestions* rather than duplicate accepts — but the guard belongs
in `selectMatchCandidates`, and `appRouteOrder`-style regression coverage belongs
in `matcher.test.ts`.

### Part 3 — Foreign-card exclusion

Three states, per the agreed behaviour:

| state | matchable | Items page | totals | UI |
|---|---|---|---|---|
| `known` | yes | shown | counted | — |
| `unknown` (null last4, 135 orders) | yes | shown | counted | "unverified card" badge |
| `foreign` (291 orders) | yes | hidden | **excluded** | "not your card" badge |

An accepted link to a tracked transaction upgrades `unknown` → `known`.

**Enforcement points.** One filter at `loadItemAllocations.ts:35` covers all nine
downstream consumers — `routes/reporting.ts`, `routes/spendByCategoryDecompose.ts`,
`routes/budgets.ts`, `routes/summary.ts`, `summary/aggregateMonthly.ts`,
`summary/aggregateDashboard.ts`, `budgets/budgetBreachCheck.ts`, and the
`splitTxnByItems` callers.

The Items page is **not** covered by it and needs the filter separately at
`routes/items.ts:430` (`GET /items`), `:266` (`/items/analyze`) and `:355`
(`/items/analyze/trend`). The two analyze endpoints apply no transaction-side
filter at all today.

Badges render in the Amazon review UI (`routes/amazon.ts:316`
`GET /review-transactions`) and on the Items page rows. `ExternalOrderView` in
`shared/api-types.ts:1144` gains a `cardOwnership` field — derived at
serialization, not stored.

### Part 4 — Merge duplicate orders *(unlocks 9 transactions)*

When an `amazon_report` row and an email row share a `vendor_order_id`, they are
two views of one order and currently compete as separate `ExternalOrder`s.

Resolution: **the email total wins.** Evidence above shows the CSV carries a
per-shipment partial while the email carries the full order total that matches
the card charge.

Merge on `vendor_order_id` where both are non-null: keep one order, take the
maximum total, union the items, prefer a non-null `payment_last4`, prefer a
non-null `order_date`. Orders without a `vendor_order_id` are untouched —
`amazonOrderDedupeKey` already handles those.

### Part 5 — Auto-accept wiring *(unlocks 15 transactions)*

Give `backfillAutoAcceptAmazonLinks` a caller. It already implements the correct
rule (`AUTO_ACCEPT_THRESHOLD=85`, `AUTO_ACCEPT_MARGIN=10`, sole-candidate only).

Call it at the end of `runAmazonMatching` so every matching run reconciles links
created before auto-accept existed.

### Part 6 — Scheduled ingestion

A `gmail_receipt_scan` job definition modelled on
`jobs/definitions/simplefinSync.ts`, registered in `jobs/registry.ts`, with an
`env`-backed cron default. It runs `scanInbox` for each household with a
connected Google integration, then `runAmazonMatching`.

The existing pg advisory lock prevents overlap with a manual scan.

**Not code:** the Chrome extension has produced zero rows despite shipping.
Determine whether it is uninstalled or whether the capture token was never
pasted into Options. Out of scope for this spec; worth an issue.

### Part 7 — Prime membership is not an order

`AMAZON.CA PRIME MEMBER` charges ($111.87 annual, 2 transactions) are a
subscription, never an Amazon order, and can never match. They should stop
appearing in the review queue permanently.

Exclude them in `runAmazonMatching`'s transaction scan, **not** by narrowing
`isAmazonLikeMerchant`. That predicate is also used inside
`scoreAmazonOrderMatch` for the +15 merchant bonus and is exported for use
elsewhere; narrowing it would silently change scoring for unrelated
transactions. Add a separate `isAmazonSubscriptionCharge(merchant)` predicate
matching the specific `PRIME MEMBER` string and filter on it in the scan.

Note that `isAmazonLikeMerchant` matches `prime` generally, which correctly
includes Prime Video rentals — those *are* orders. Only the membership charge is
excluded.

## Expected outcome

| source | transactions |
|---|---:|
| Part 1 — undated orders become matchable | 30 |
| Part 4 — duplicate-order merge | 9 |
| Part 5 — auto-accept the existing suggestions | 15 |
| **Total newly linked** | **~54** |

Against 111 Amazon transactions, that is roughly **49% linked and itemized**,
from 0% today. Remaining: 8 genuinely-absent orders, 2 Prime membership charges
(structurally unmatchable, excluded by Part 7), and 6 ambiguous exact-cent cases
that correctly abstain and await manual resolution.

Parts 2, 3, 6 do not add linked transactions. Part 2 improves precision and
powers Part 3; Part 3 removes 291 foreign orders from the Items page and every
spend total; Part 6 stops the corpus going stale again.

## Testing

Backend unit tests are colocated (`foo.test.ts` beside `foo.ts`) and run under
`node:test` via `tsx`.

- `matcher.test.ts` — the exact-cent band: an exact-cent undated order beats a
  near-miss on `secondaryScore`; two exact-cent orders abstain; an exact-cent
  order with no last4 match does **not** enter the `strong` tier; **with** a
  last4 match it does, and two such candidates tied at 85 abstain rather than
  fan out (the Part 1b × Part 2 regression guard); last4 mismatch penalty
  applies only when both sides carry a last4.
- `cardOwnership.test.ts` — `short_code` suffix extraction across all three
  formats; opaque alphanumeric yields null; null `payment_last4` → `unknown`;
  shared last4 across two accounts → `known`.
- `scanReceipts.test.ts` — `internalDate` fallback populates `orderDate` when the
  parser returns null, and does **not** override a parsed date; `forceReprocess`
  updates only null fields on an existing row.
- `parsers/amazon.test.ts` — `DATE_RE` against a day-of-week prefix and
  `Ordered on`; parser merge produces date + total + last4 from a fixture where
  neither parser alone does.
- `mergeOrders.test.ts` — email total wins over a partial CSV total; items are
  unioned without duplication; orders lacking `vendor_order_id` are untouched.
- `loadItemAllocations.test.ts` — foreign orders excluded from allocation;
  `unknown` orders included.
- `items.test.ts` — all three endpoints honour the ownership filter.
- Fixtures for the parser tests come from real `raw_payload` bodies in
  production, scrubbed.

Verification against production after merge: re-run the partition query and
confirm the linked count moves from 0 toward ~54, and that no foreign-card order
acquires an accepted link.

## Rollout

Parts land in payoff order: 1 → 5 → 4 → 2 → 3 → 6 → 7.

They are independently shippable with one exception: **Part 2's strong-tier tie
guard must merge in the same change as Part 2's last4 signal**, never after it.
Turning the last4 signal on without the guard is precisely what pushes
exact-cent candidates into the ungated `strong` tier. Part 3 depends on Part 2's
resolver; everything else is free-standing.

Part 1e (reprocess) is a one-time operation, run manually after 1a–1d merge.

Part 2's mismatch penalty is the one change with downside risk; verify against
production before merging it, and ship it separately from the rest of Part 2 if
the verification is inconclusive. The tie guard is not optional in the same way —
it ships with the signal.
