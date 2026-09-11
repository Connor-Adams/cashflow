# Account card identifiers + reversible order merge — design

Date: 2026-09-11
Status: proposed

## Problem

Two problems, both left behind by `2026-09-10-amazon-email-matching-design.md`.

### 1. An account can only hold one identifier, and it is already spoken for

`accounts.short_code` is an **import key**. `runImport.ts:1127` and `:863` key
account lookup on it, `parseStatementFile.ts:542` matches on it, and
`resolvePdfAccountFromHeader` (`runImport.ts:1105`) writes a statement's
`accountSuffix` into it.

It is also, currently, the only place a card last-4 can live —
`resolveAccountLast4` parses it. For Amex and RBC that happens to work
(`701001` → 1001, `5234` → 5234). For **Costco MC it does not**: its
`short_code` is the literal string `'costco'`, the token that matches its import
files, while its real card is `3114`.

One column, two jobs. The card number loses.

`accounts.bank_account_number` exists and is NULL on all 29 production accounts.
It is a single value and means "bank account number", not "card last-4"; it does
not solve this.

### 2. The nightly merge is the repo's only unattended hard delete

`mergeDuplicateAmazonOrders` runs as the first statement of `runAmazonMatching`,
which the `gmail_receipt_scan` cron calls nightly with `enabledDefault: true`. It
hard-deletes losing `ExternalOrder` rows — up to 75 on the first run against
current production data.

Every other bulk irreversible mutation in this codebase ships a `dryRun` and is
**manually triggered**: `restoreBundle.ts`, `wsDepositActivityMigration.ts`,
`interacCounterparty.ts`, `runEnrichmentBackfill.ts`. None of them is wired to a
cron. This one is neither dry-runnable nor manual.

That is why the previous work shipped with a "trigger matching manually once and
inspect before the cron arms" caveat. The caveat is the thing to remove.

## Evidence

Production, queried 2026-09-11.

### Where card numbers actually come from

Every PDF statement parser already extracts a card last-4 and throws it away
into `short_code`:

| parser | file:line | reads |
|---|---|---|
| CIBC Costco Mastercard | `pdf/cibcCostcoMastercard.ts:101` | `/5160\s+XXXX\s+XXXX\s+(\d{4})/` |
| RBC Visa | `pdf/rbcVisa.ts:54` | card last-4 from header |
| Wealthsimple CC | `pdf/wealthsimpleCreditCard.ts:38` | card last-4 |
| Wise | `pdf/wiseStatement.ts` | last-4 of account number |
| Costco till receipt | `pdf/receipts/costcoTillReceipt.ts:26` | `/X{4,}(\d{4})/` off the tender |

### What each candidate route would actually yield

| route | accounts covered | **new** information |
|---|---|---|
| Filename regex `Statement-(\d{4})` | 17, 18, 19, 20, 21, 22, 23, 28 | **none** — all eight already agree with `short_code` |
| Parse `short_code` | 1 → 1001, 40 → 1005, +14 others | none — already shipped in `resolveAccountLast4` |
| **Order / tender `payment_last4`** | **5 → 3114** | **the only route yielding anything new** |

Two facts kill the obvious approach:

- **`account_statements` is empty — 0 rows, repo-wide.** Any design harvesting
  into or out of that table produces nothing.
- **Costco MC has zero `import_histories` rows.** Every statement-import-shaped
  route gives account 5 exactly nothing. It would ship a table that stays empty
  for the one account that motivated it.

### The source filter that makes this safe

Exactly one piece of existing last-4 data is wrong, and its source names it:

| account | last-4 | source | verdict |
|---|---|---|---|
| 5 Costco MC | `3114` | `costco_till_receipt-pdf` | correct — 4 accepted links agree, 29 more orders corroborate |
| 1 Amex Reserve | `9907` | `gmail-scan:ai` | **wrong** — an AI misparse on an Uber Eats receipt |

**Trust last-4s from deterministic parsers. Never from AI extraction.** That one
rule keeps `3114` and drops `9907`.

### Transaction rows carry no card data at all

A scan of all 5,361 transactions across every text column found **zero** card
suffixes. `source_reference` and `merchant_canonical`: 0 matches. `merchant_raw`
matches are store numbers and phone numbers. Masked-card patterns (`xxxx`,
`****`): 0 rows. The transaction side is not a source and never will be.

## Non-goals

- **Harvesting from `account_statements`.** The table is empty; it is a dead end.
- **Filename-derived last-4s.** Adds zero information over `short_code`.
- **AI-extracted last-4s.** The single known-bad datum comes from exactly there.
- **Manual entry of card numbers.** The requirement is that nothing needs typing.
- **Widening the backfill to amount+date matching.** It would credit four more
  accounts but also re-derive the bogus `9907`, so it is not self-cleaning. The
  accounts it would reach are already covered by `short_code`.
- **A dry-run mode, first-run suppression of auto-accept, per-run audit records,
  or a guard on `runAmazonMatching` itself.** Considered and deliberately
  declined: auto-accept is already reversible through
  `POST /api/amazon/links/:id/reject`, which restores forward-looking state. The
  hard delete was the only *irreversible* step, and making it reversible is the
  whole ask. Residual accepted risk: a false budget-breach notification can fire
  overnight on a bad match before anyone looks.

## Primitives check

Per `docs/superpowers/specs/2026-05-30-cashflow-primitives-design.md`:

- **`account_card_identifiers`** — a child table on **Account**, an existing
  primitive, holding a 1:N relation. No new status machine, no new noun. The
  build rule sanctions this: *"Persistent state → which primitive owns it? Add a
  column or child table."*
- **`external_orders.deleted_at`** — a column on **Document**. Soft-delete is a
  lifecycle refinement of an existing primitive, not a new machine.

**Zero new primitives. Two migrations** — unlike the previous branch, which
promised and delivered zero. Both are additive: one new table, one nullable
column.

## Design

### Part 1 — `account_card_identifiers`

A new table, one row per (account, card last-4):

| column | notes |
|---|---|
| `id` | PK |
| `household_id` | FK, scoping — matches the convention on sibling tables |
| `account_id` | FK to `accounts` |
| `last4` | `CHAR(4)`, digits only |
| `source` | which parser produced it, e.g. `pdf_statement_header`, `receipt_tender`, `backfill:receipt_tender` |
| `first_seen_at` / `last_seen_at` | so a stale identifier is visible |

Unique on `(account_id, last4)` — re-harvesting the same card is idempotent.

An account may have many rows. A last-4 may map to more than one account; that
is already handled — `buildLast4Map` returns `Map<string, number[]>`.

### Part 2 — harvest at import time, deterministic sources only

Two hooks, both at the point where an import is already bound to an account:

**Statement headers.** In `resolvePdfAccountFromHeader` (`runImport.ts:1105`),
once the account is resolved, if `header.accountSuffix` is exactly four digits,
upsert an identifier with `source: 'pdf_statement_header'`. This fires whether
the account was matched by `short_code`, by the Wealthsimple `wsid` path, or by
the name fallback — so an account keyed by a filename token (Costco) still gains
its card number.

**Receipt tenders.** When a receipt-derived order is anchored to a transaction,
if its tender carries a `paymentLast4` **and the order's `source` is on the
deterministic allowlist**, upsert against that transaction's account with
`source: 'receipt_tender'`.

**The allowlist is the load-bearing part.** Sources whose last-4 came from a
regex over parsed document text are trusted; sources whose last-4 came from an
LLM are not. `gmail-scan:ai` and any future AI-extracted field are excluded by
construction, not by heuristic.

### Part 3 — one-time backfill

Idempotent, safe to re-run. Walk `external_order_tenders` and `external_orders`
whose `source` is on the deterministic allowlist, follow their
`TransactionOrderLink` rows to the linked transactions' accounts, and upsert
identifiers with `source: 'backfill:<original source>'`.

Against current production this writes exactly one new row: **account 5 → 3114**.
That is the correct outcome — every other account's last-4 is already
recoverable from `short_code`, and the backfill must not manufacture more.

The `gmail-scan:ai` exclusion is what stops it also writing `9907` onto account 1.

### Part 4 — `resolveAccountLast4` becomes many-valued

`cardOwnership.ts` gains a resolver that returns **all** last-4s for an account:
the `account_card_identifiers` rows, **unioned with** the existing
`resolveAccountLast4(shortCode)` result.

Keeping the `short_code` fallback is deliberate and load-bearing: Amex Reserve
and Amex Cobalt have 71 PDF imports between them whose filenames are date-only,
so they will never gain an identifier row from harvesting. Their `1001` and
`1005` must keep coming from `short_code` parsing, exactly as they do today.
Dropping the fallback would silently break the two accounts that currently work.

`buildLast4Map` and `classifyCardOwnership` keep their signatures. Only the
source of the last-4 set widens.

### Part 5 — reversible merge

Make `ExternalOrder` paranoid (`paranoid: true`, `deleted_at` column). Sequelize
then turns the existing `loser.destroy()` in `mergeDuplicateOrders.ts` into a
soft delete automatically, and excludes soft-deleted rows from all **41**
`ExternalOrder` query sites without touching any of them.

This is the reason to use `paranoid` rather than hand-rolling a `deletedAt`
filter: with 41 read sites, the failure mode of the manual approach is one missed
filter resurrecting merged orders into a spend total. No model in this codebase
is paranoid today, so this introduces the pattern — but it is a Sequelize
built-in, not an invention.

**What this buys:** a merge that folded the wrong rows is now recoverable with
`restore()`. The cron's only irreversible step stops being irreversible, and the
"run it manually once and inspect first" caveat can be dropped.

**Scope note:** colliding `ExternalOrderItem` rows are still hard-deleted, and
that is correct — their hand-entered overrides are copied onto the surviving twin
before deletion, so nothing a user typed is lost. Only orders become paranoid.

**Verification required during implementation:** every one of the 41 sites must
be checked for a place that *should* still see soft-deleted rows (an admin view,
a dedupe-key uniqueness check, a foreign-key join). Any such site needs an
explicit `paranoid: false`.

## Expected outcome

| | before | after |
|---|---|---|
| Accounts with a resolvable card last-4 | 16, all via `short_code` | 17 — adds Costco MC via `3114` |
| Costco MC | no card identity | `3114`, from data already in prod |
| Cards per account | exactly one | many |
| Merged orders | hard-deleted, unrecoverable | soft-deleted, `restore()`-able |
| Cron first run | needs a supervised manual pass | safe to run unattended |

Zero manual data entry. The user imports nothing new.

## Testing

Backend tests are colocated (`foo.test.ts` beside `foo.ts`) under `backend/src/`,
run with `node:test` via `tsx`.

- `accountCardIdentifiers.test.ts` — upsert is idempotent; `(account_id, last4)`
  uniqueness holds; a non-4-digit suffix is rejected; a last-4 shared by two
  accounts produces two rows.
- Harvest tests — a PDF statement header with a 4-digit suffix writes an
  identifier for the resolved account, **including when that account was matched
  by a filename token rather than by `short_code`** (the Costco shape); a
  receipt tender from `costco_till_receipt-pdf` writes one; a
  `gmail-scan:ai`-sourced last-4 writes **nothing**.
- `backfill.test.ts` — seeded to mirror production: a Costco till-receipt tender
  carrying `3114` linked to an account-5 transaction yields one identifier; an
  AI-sourced `9907` on an Uber Eats order linked to account 1 yields **none**;
  re-running changes nothing.
- `cardOwnership.test.ts` — an account with both a `short_code`-derived last-4
  and an identifier row resolves to both; an account with only `short_code`
  (Amex) still resolves, proving the fallback survives.
- `mergeDuplicateOrders.test.ts` — a merged loser is absent from a normal query
  but present under `paranoid: false`, and `restore()` brings it back with its
  items and links intact.
- A regression test that a soft-deleted order does **not** appear in
  `loadItemAllocationContext`, the Items endpoints, or any spend total.

Verification against production after merge: confirm account 5 gained exactly one
identifier (`3114`), that no account gained `9907`, and that the identifier count
is 1, not 5 — over-harvesting is the failure mode to watch for.

## Rollout

Part 1 → 4 → 2 → 3 → 5. Parts 1–4 are the card-identifier change and are
independently shippable; Part 5 is orthogonal and can land in either order.

Part 3's backfill is a one-time operation, run after Parts 1–2 merge, and is
idempotent so a re-run is harmless.
