# Multiway transaction split

**Date:** 2026-06-23
**Status:** Approved design, pending implementation plan

## Problem

A transaction can currently be split only **two ways** — "me" vs. a single
"partner" — via the Transaction columns `final_split_type` / `final_pct_me` /
`final_pct_partner` / `my_share_amount` / `partner_share_amount`, which feed the
partner-fairness dashboards.

Real spend often involves **more than two people**: a ski-trip lunch shared by
self + Dad + a partner, groceries that are entirely someone else's, a dinner
split N ways. Today the only way to record this is to hand-craft one
`reimbursements` row per person — exactly the manual work done for the France
2026 trip (16 claims created by raw SQL).

We want a first-class **multiway split** action: pick the other participants,
choose even or percentage shares, and have the system create the owe-back claims.

## Core principle (the build rule)

This is **not a new primitive**. It introduces no new status machine. It is an
**action on the Transaction primitive** that generates **Reimbursement** records
(the existing "money owed back to you" ledger, issue #216, which is already 1:N
transaction→claims).

- **Transaction** stays the owner of the outlay.
- **Reimbursement** stays the owe-back machine.
- "Multiway split" is the *operation* that derives a set of claims from a txn.

Per the primitives spine: split is a derived view/operation over existing
machines, folded via the existing Reimbursement model — not a fork.

## Semantics

In a multiway split, **the payer (the household "me") always fronts the money and
the other participants owe their share back.** There is no case where "me" owes
another participant — that asymmetry is the whole definition of multiway here.

- **Participants** are Contacts (Dad, Alex, friends). *You* ("me") are an
  **implicit participant** holding the remainder; you never get a claim against
  yourself.
- **Even split:** each of `(you + N contacts)` gets `1 / (N + 1)` when
  `includeSelf` is true; each of `N` contacts gets `1 / N` when `includeSelf` is
  false.
- **Percent split:** caller sets a `pct` per contact. **Your share = 100 −
  Σ(others).** Validate `Σ(others) ≤ 100`. A contact at 100 / yourself at 0 is
  the "all-Dad" case.
- **Rounding:** each claim `amount = round(share × ABS(txn.amount), 2)`. Any
  leftover cent stays with you (you have no claim to round), so claims never
  exceed the txn total.

### Relationship to the 2-way partner-shared split

A multiway split **replaces** the me/partner `shared` model on that transaction;
the two are mutually exclusive. When a split is applied:

- The txn is set to `ownership_type = 'me'` and `final_split_type = 'me'`
  (`my_share_amount = amount`, `partner_share_amount = 0`).
- This **deliberately removes the txn from the partner-fairness `shared` pool**,
  so a partner (e.g. Alex) who participates via a claim is **not double-counted**
  in both partner-fairness and reimbursements.

A transaction is therefore *either* a 2-way partner-shared split *or* a multiway
split, never both at once.

## Data model

One additive column on `reimbursements`:

| column | type | default | purpose |
|---|---|---|---|
| `from_split` | BOOLEAN | `false` | Marks a claim created by the multiway-split action (vs. a manually-created claim). Lets re-split replace its own claims idempotently without disturbing ad-hoc claims. |

Migration: `backend/src/migrations/YYYYMMDD-reimbursements-from-split.js`, adding
the column with default `false` (backfills existing rows to `false`). Reversible.

No changes to the Transaction split columns themselves — the action *writes*
existing columns (`ownership_type`, `final_split_type`, share amounts) to their
"me" values, it does not add new ones.

## API

### `POST /api/transactions/:id/split`

Mounted in `backend/src/routes/reimbursements.ts` (claim-centric router, already
on `/api`).

Request body:

```jsonc
{
  "method": "even" | "percent",
  "participants": [
    { "contactId": 3 },              // even: pct ignored
    { "contactId": 7, "pct": 25 }    // percent: pct required, 0..100
  ],
  "includeSelf": true                 // optional, default true; false => you keep $0
}
```

Behavior (in a DB transaction):

1. Load the txn via `visibleTransactionWhere`; 404 if not visible; 400 if no
   `household_id`.
2. Validate:
   - `method` ∈ {`even`,`percent`}.
   - `participants` non-empty.
   - every `contactId` ∈ household (reuse `contactInHousehold`).
   - no participant is a `is_self` contact (can't owe yourself) → 400.
   - `percent`: each `pct` is a finite number in `(0, 100]`, and
     `Σ(others) ≤ 100` → else 400.
3. Compute each participant's share amount off `ABS(txn.amount)`.
4. Delete existing `reimbursements` rows for this txn where `from_split = true`.
5. Insert one claim per participant: `contact_id`, `amount`, `currency =
   txn.currency`, `status = 'expected'`, `from_split = true`,
   `created_by_user_id = caller`, `notes` describing the split
   (e.g. `"Multiway split — even 1/3"`).
6. Set the txn to `ownership_type = 'me'`, `final_split_type = 'me'`,
   recompute share amounts (`recomputeTransactionAmounts`).
7. Return `{ transaction, claims }` (claims serialized like other reimbursement
   responses).

### `DELETE /api/transactions/:id/split` (unsplit)

Removes only this txn's `from_split = true` claims and returns the txn to a plain
`me` ownership. Manually-created claims (`from_split = false`) are untouched.
Returns `{ transaction }`.

### Share math helper

A pure, unit-tested function in `backend/src/reimbursements/splitShares.ts`:

```
computeSplitShares(amountAbs, method, participants, includeSelf)
  -> { shares: Array<{ contactId, amount }>, selfAmount }
```

No I/O; all rounding and percentage logic lives here so it can be exhaustively
tested.

## Frontend UX

Extend the existing split editor inside `frontend/src/pages/TransactionsPage.tsx`
(the `TransactionRow` editor, ~lines 2240–2302):

- The split-type `<NativeSelect>` gains a **`multiway`** option alongside
  `(auto)/me/partner/shared`.
- Selecting `multiway` swaps the me/partner percent inputs for a **participant
  editor**:
  - **+ Add person** — contact picker (reuse the contact dropdown already used by
    `ownershipContactId`).
  - An **Even** toggle. When on, shares are equal and the % fields are hidden.
  - When off, a **%** input per participant.
  - A live read-out: **"Your share: $X (Y%)"**, recomputed as participants/percents
    change.
- **Save** calls `POST /api/transactions/:id/split`. The row then shows a
  **multiway badge** + participant count.
- A **Clear split** affordance calls the `DELETE` unsplit endpoint.
- The generated claims appear on the **existing Reimbursements page**
  (`frontend/src/pages/ReimbursementsPage.tsx`), already grouped by contact — no
  new page or route.

Types updated in `shared/api-types.ts` (`@cashflow/shared`) for the split request
and the split response shape.

## Error handling

- `Σ(others) > 100` (percent) → 400 with a clear message.
- Empty `participants` → 400.
- `contactId` not in household → 400.
- `is_self` contact as participant → 400 ("cannot owe yourself").
- Re-split is **idempotent** — it replaces its own prior claims, never appends.
- Unsplit on a txn with no split claims → no-op success (still returns the txn).
- Currency of every claim equals the txn currency, preserving repayment matching.

## Testing

- **Unit** (`splitShares.test.ts`): even split (2/3/4-way, with and without self),
  percent split, rounding leftover-cent stays with self, `Σ ≤ 100` boundary,
  exclude-self even split.
- **Route** (`reimbursements` route tests): create split → N claims +
  txn set to `me`; re-split replaces (`from_split` claims swapped, manual claims
  preserved); unsplit removes only `from_split`; all validation 400s; partner
  contact participates as a normal claim and the txn leaves the `shared` pool.
- **Migration test** (`backend/src/migrations/__tests__/`): `from_split` column
  added with default `false`, reversible.

## Out of scope (v1, YAGNI)

- **Bulk** multi-transaction split (apply one split across many selected rows).
  The trip workflow that motivated this was bulk, but single-txn is the agreed
  v1; bulk can layer on later by iterating the same endpoint.
- **Custom dollar amounts** per participant (only even + percent for v1).
- Weighting partners differently from other contacts — a participant is a
  participant.
- Splitting a txn that someone *else* fronted (would invert the owe direction —
  explicitly excluded by the semantics above).
