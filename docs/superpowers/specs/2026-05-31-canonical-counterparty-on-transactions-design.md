# Canonical counterparty on transactions — design

**Date:** 2026-05-31
**Primitive:** Counterparty (realized as the `Contact` model + `Transaction.counterpartyContactId` FK)
**Spine impact:** None. Adds a column to `contacts`, reuses the existing `transactions.counterpartyContactId` FK, adds derivations. No new table, no new status machine.

## Problem

A transaction can represent money to/from a specific person ("sent a buddy $50", "partner sent me $600"), but there is no way to tag a single transaction with a **canonical** person:

- `transactions.counterpartyContactId` (FK → `Contact`) is the canonical link, but it is **not** in `PATCHABLE_KEYS` and the UI shows it read-only — no per-transaction control to set it.
- `counterpartyRaw` (free text) is already extracted on import by `extractCounterparty` ([backend/src/import/extractCounterparty.ts](../../../backend/src/import/extractCounterparty.ts)), but linking it to a `Contact` is **suggest-only**: `findCounterpartyPromotions` waits for a name to repeat ≥3× before suggesting promotion ([backend/src/ai/counterpartyPromotions.ts](../../../backend/src/ai/counterpartyPromotions.ts)).
- `runCounterpartyBackfill` ([backend/src/import/counterpartyBackfill.ts](../../../backend/src/import/counterpartyBackfill.ts)) backfills `counterpartyRaw` only — never the Contact link.
- No find-or-create for `Contact`; creation is manual via `POST /contacts` with no name dedup.

## Decisions (with rationale)

1. **Create policy: find-or-create (full auto).** On import and backfill, auto-create-and-link a `Contact` when a person is detected — not suggest-only. Chosen over the existing suggest-after-3 model. Spam risk is contained by the two mitigations below.
2. **Scope: people only.** Auto-create fires only for person-to-person patterns (Interac e-transfer, Zelle, Venmo, CashApp). Payroll / direct-deposit lines keep `counterpartyRaw` (as today) but do **not** auto-create a Contact. Keeps `Contact` a people directory matching the "personal transfers" framing.
3. **Direction is the amount sign.** Negative = money out (you sent), positive = money in (they sent you). No new field; UI derives a "→ to / ← from" label.

### Anti-spam mitigations (these make full-auto safe; they are correct implementation, not options)

- **Dedup by normalized key.** Find-or-create keys on `normalizeCounterpartyName(raw)` (lowercase, ref-suffix + trailing-digit stripping — already implemented and used by promotions), backed by a unique index on `contacts(household_id, normalized_name)`. "…TO JOHN SMITH REF 8842" and "…REF 9931" collapse to one "John Smith".
- **Gated on real party lines.** `counterpartyRaw` is only populated when `extractCounterparty` matches a known pattern; generic merchant lines never carry a counterparty, so they never spawn a contact. Auto-create is further gated to `kind === 'person'`.

## Data model

- **New column `contacts.normalized_name`** — `normalizeCounterpartyName(name)`. Unique index `(household_id, normalized_name)`. Mirrors the account `shortCode` race-safe find-or-create at [runImport.ts:936](../../../backend/src/import/runImport.ts).
  - Migration backfills `normalized_name` for existing contacts. On collision (two existing contacts normalize to the same key in one household) keep the oldest row's claim to the key; the loser gets a disambiguated `normalized_name` (e.g. suffix `#<id>`) so the unique index can be created without data loss. Stored as TEXT for the SQLite migration round-trip tests the codebase already runs.
- **`transactions.counterpartyContactId`** — already exists, no change.
- **No direction column.** Derived from `amount` sign.

## Components

### Shared resolver (new)

`resolveCounterpartyContact(householdId, raw, kind) → contactId | null`

- Returns `null` unless `kind === 'person'`.
- `normalizeCounterpartyName(raw)` → key; `Contact.findOrCreate` on `(householdId, normalized_name=key)` with display `name` = title-cased raw, `isPartner=false`.
- Single unit, called by both import (PR B) and backfill (PR C). Lives under `backend/src/import/` alongside the other counterparty helpers.

### `extractCounterparty` change

- Return shape grows from `string | null` to `{ name: string; kind: 'person' | 'payroll' } | null` so callers can gate auto-create. All call sites updated (notably `commitStatementImport` and `counterpartyBackfill`). `counterpartyRaw` is still set for both kinds (no behavior change to the raw column).

### `POST /contacts` change (delivered in PR B)

- Compute and store `normalized_name` on manual create, with find-or-create semantics: if a contact with that `normalized_name` already exists in the household, return it instead of creating a duplicate. Delivered in PR B (needs the column). PR A's inline create uses the endpoint as-is; PR B's migration backfills `normalized_name` for any contacts made before then.

## Build sequence (three PRs)

### PR A — Manual per-transaction picker (independent, ships first, no migration)

- Add `counterpartyContactId` to `PATCHABLE_KEYS` ([transactions.ts:250](../../../backend/src/routes/transactions.ts)), accepting a contact id or `null` (clear).
- Replace the read-only counterparty badge at [TransactionsPage.tsx:1897](../../../frontend/src/pages/TransactionsPage.tsx) with an inline combobox: search existing Contacts (`GET /contacts`), select, or "Create '<name>'" inline (`POST /contacts` → PATCH txn). Mirror the existing ownership/split inline-edit cell at [TransactionsPage.tsx:1983](../../../frontend/src/pages/TransactionsPage.tsx).
- Render a "→ to / ← from" affordance derived from `amount` sign.

**Acceptance:**
- PATCH a transaction with `counterpartyContactId` links it; PATCH `null` clears it; a foreign id outside the household is rejected.
- Inline "create + link" produces a Contact and links it in one flow (using the existing `POST /contacts`; `normalized_name` is backfilled later by PR B's migration).

### PR B — Import auto-link (depends on resolver + migration)

- Migration: `contacts.normalized_name` + unique index (per Data model).
- `extractCounterparty` returns `{name, kind}`; add `resolveCounterpartyContact`.
- At commit time where `counterpartyRaw` is written ([commitStatementImport.ts:328](../../../backend/src/import/commitStatementImport.ts)): if `kind==='person'`, resolve and set `counterpartyContactId` on the built transaction. **Not** a new enrichment stage — stages emit pure `SignalFields` and do not create rows (`counterpartyContactId` is not in `SignalFields`), so co-locating with the raw write keeps the pipeline pure and avoids merge clobber.

**Acceptance:**
- Importing a statement with an e-transfer line creates exactly one Contact and links the transaction.
- Re-importing the same statement is idempotent (no duplicate Contact, link unchanged).
- A payroll / direct-deposit line sets `counterpartyRaw` but creates **no** Contact.
- Two lines for the same person with different ref numbers link to the same Contact.

### PR C — Backfill enrichment (depends on resolver)

- Extend `runCounterpartyBackfill` ([counterpartyBackfill.ts:153](../../../backend/src/import/counterpartyBackfill.ts)): broaden scope from `counterpartyRaw IS NULL` to `counterpartyContactId IS NULL`. Per row: ensure `counterpartyRaw` (extract if missing), and if `kind==='person'`, resolve + set `counterpartyContactId`. Preserve dry-run, `ProviderJobLog` summary, and the per-household in-flight lock.

**Acceptance:**
- Existing rows with a person `counterpartyRaw` but null `counterpartyContactId` get linked.
- Existing rows with no raw get raw extracted, then linked when person-kind.
- Dry-run reports counts without writing.
- Idempotent across repeated runs; payroll rows never gain a Contact.

## Known behaviors (intentional, called out)

- **Partner flag is manual.** An auto-created Contact for your partner has `isPartner=false`. Toggle it once in Contacts → Partner Fairness picks it up and future transactions link automatically.
- **No contact merge.** A manually-named contact ("Mom") and an auto-created one ("Jane Doe") for the same person stay separate.

## Out of scope (YAGNI)

- Contact merge / alias management.
- Auto-detecting `isPartner`.
- Auto-creating Contacts for payroll/org counterparties.
- Unifying the four existing personal-transfer surfaces (Transfers, Reimbursements, Contacts, PartnerSettlement) into one view.

## Testing

- **Resolver (unit):** ref-noise dedup, person vs payroll gate, find vs create, household scoping, unique-index race.
- **Migration:** `normalized_name` backfill, collision disambiguation, SQLite round-trip.
- **Import (integration):** create+link, idempotent re-import, payroll → no contact, ref-variant → same contact.
- **Backfill (integration):** link existing raw-only rows, extract-then-link, dry-run counts, idempotency, payroll exclusion.
- **Manual picker:** PATCH allow/clear/cross-household-reject; inline create+link.
