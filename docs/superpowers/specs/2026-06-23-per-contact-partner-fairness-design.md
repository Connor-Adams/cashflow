# Per-contact partner fairness + visible paybacks

**Date:** 2026-06-23
**Status:** Approved design, pending implementation plan

## Problem

The Partner Fairness dashboard (`/api/partner/*`, rendered by `PartnerHomePage`
and `PartnerFairnessPage`) is **single-partner per currency**. It merges every
contact's data into one "partner" balance at three points in
`backend/src/summary/partnerFairness.ts`:

1. **Settlements** are summed across all contacts per currency
   (`buildFairnessByCurrency`, the `settlementByCurrency` loop) — contactId is
   discarded.
2. **`partnerShare`** is summed across all shared rows regardless of which
   contact the split is with.
3. **Partner transfers** (`computePartnerTransferDelta`) fold in inbound/outbound
   transfers for *any* `is_partner` contact.

### Concrete failure (prod, 2026-06-23)

The household has one real partner, **Alex** (contact 7, `is_partner=true`), and
peer-lending with **Dad** (contact 3, not a partner). The all-time CAD balance
computes to:

```
  19,915.38   (−partnerShareTotal: Alex shared $18,811.58 + Dad partner-row + a Golf partner row ≈ $1,104)
− 11,198.30   (Dad's settlement "NORTHVUE GLASS squared up")
−  8,425.00   (Alex transfers incl. a $7,000 payback, tagged counterparty_contact_id=7)
= ~$292       → dashboard reads "even"
```

This is wrong: Dad's peer-lending bleeds into Alex's balance. The **clean**
Alex-only balance is `18,811.58 − 8,425 = $10,386.58` (Alex owes Connor).

A second, related issue: the $7,000 Alex payback **was** already netting (via the
tagged-transfer path) but was **invisible** — there is no UI surface that shows a
payback arrived, so it looked uncounted.

## Goals

- Per-contact balances: Alex and Dad (and any future contact) each get their own
  balance, never merged.
- Correct Alex-only headline as a consequence.
- Paybacks visible: a tagged bank transfer that nets a balance must be shown.
- No double-counting of paybacks.
- No schema migration, no data backfill.

## Non-goals

- Multi-partner data entry (a contact picker on the split control). The design
  assumes a single `is_partner` contact and attributes unlabeled splits to it.
  Adding a second partner is a follow-up (see Attribution guard).
- Changing import/tagging behavior.
- Creating a manual settlement for the existing $7k (it is already counted via
  the transfer path; we surface it instead).

## Spine classification

Not a new primitive. Partner fairness is a **derivation/view** over the
**Transaction**, **Counterparty** (contacts), and the `PartnerSettlement`
records. This change re-keys an existing derivation from per-currency to
per-(contact, currency). No new table, no new status machine.

## Design

### 1. Attribution (query-time, no backfill)

Add a pure helper to `partnerFairness.ts`:

```
contactForSharedRow(row, solePartnerId): number | null
  // row.partnerShare !== 0 (a split expense):
  //   ownershipType === 'contact' && ownershipContactId != null
  //     → ownershipContactId          (e.g. Dad's partner-row → 3)
  //     else → solePartnerId           (Alex's me/null shared rows → 7)
```

`solePartnerId` is the single `is_partner` contact id.

**Attribution guard:** if the count of `is_partner` contacts is not exactly 1,
unlabeled split rows (those without an explicit `ownershipContactId`) are
attributed to a synthetic **"Unassigned"** bucket (`contactId = null`) rather
than guessing, and a `log.warn` is emitted. This is the trigger to implement
attribution-B (per-row contact picker). Existing labeled rows (Dad) still bucket
correctly regardless.

This requires **no migration**: Alex's 282 existing shared rows have
`ownershipType='me'`/`ownershipContactId=null` and resolve to the sole partner at
query time; Dad's rows already carry `ownershipContactId=3`.

### 2. Per-contact grouping

Rename/replace `buildFairnessByCurrency` → `buildFairnessByContact`, grouping by
`(contactId, currency)`:

```
balance(contact, currency) =
    −partnerShareTotal_c
  + (settlement.iPaid_c − settlement.partnerPaid_c)
  + (transfer.out_c − transfer.in_c)
```

- Settlements are already keyed by `(contactId, currency)` in
  `loadSharedTxns` — stop collapsing them in the builder.
- `computePartnerTransferDelta` is already keyed by `counterpartyContactId` —
  return per-(contact, currency) and stop summing into one.
- `partnerShareTotal_c`, `myShareTotal_c`, `categoryBreakdown`, `largestShared`,
  `currentMonthSharedSpend` all computed within the contact bucket.

`buildFairnessMonthly` and `buildSettlementRecommendation` adopt the same
per-(contact, currency) keying (they consume the same builder/rows).

### 3. Payback visibility (model B — transfers canonical)

Paybacks are **counted once** by the existing math (settlement delta and transfer
delta are disjoint: a transfer row requires `partnerShare === 0`, a settlement is
a separate `PartnerSettlement` record). The change is **display only**: per
contact, assemble

```
paybacks[] = PartnerSettlement rows (source: 'settlement')
           + tagged partner transfers (txns: counterpartyContactId = contact,
                                        partnerShare = 0, amount ≠ 0)
                                        (source: 'transfer')
```

Each entry: `{ source, date, amount, currency, direction, note }`. `direction`
derives from sign (inbound = partner paid me, outbound = I paid partner).

Manual `PartnerSettlement` records remain for paybacks with **no** imported
transaction (untracked cash). No manual $7k settlement is created.

### 4. API shape

`GET /api/partner/fairness` response changes from a flat per-currency list to
per-contact:

```
{
  contacts: [
    {
      contactId: number | null,        // null = "Unassigned" guard bucket
      contactName: string,
      isPartner: boolean,
      byCurrency: FairnessByCurrency[], // existing shape, now contact-scoped
      paybacks: PaybackEntry[]
    }
  ],
  excludeNonPartnerInflows: boolean
}
```

`/monthly` and `/settlement-recommendation` similarly nest under `contacts`.
`frontend/src/types/api.ts` updated to match (`PartnerFairnessResponse`,
new `PartnerFairnessContact`, `PaybackEntry`).

### 5. Frontend

- **PartnerHomePage** — the dashboard card shows the `is_partner` contact's
  balance (Alex), not the merged number. If multiple `is_partner`, show the sum
  of partner contacts (still excludes Dad).
- **PartnerFairnessPage** — one section per contact: balance + direction,
  payback list with `source` badges ("bank transfer" vs "manual"), category
  breakdown, largest shared, monthly trend. `is_partner` contacts render first
  under "Partners"; non-partner contacts (Dad) under "Other balances".

### 6. Testing

`partnerFairness.ts` / `partnerMath.ts` are pure and unit-tested (colocated
`*.test.ts`). Add:

- **Conflation regression:** fixture with Alex shared rows + Dad partner-row +
  Dad settlement + Alex inbound transfer → asserts **two** contact buckets, Alex
  balance `10,386.58`, Dad balance correct, neither contaminated.
- **Payback assembly:** asserts `paybacks[]` contains both the transfer and a
  settlement with correct `source`, and that balance is unchanged (counted once).
- **Attribution guard:** 0 and 2 `is_partner` contacts → unlabeled rows land in
  the "Unassigned" bucket, `log.warn` emitted.
- **Per-contact monthly + recommendation:** smoke tests that keying is
  per-contact.

Route-level: `backend/test/integration` (or route test) asserting the new
`contacts[]` response shape.

## Migration / rollout

None. Query-time attribution means the fix applies to existing prod data on
deploy. The data already written this session are the 282 Alex 50/50 `shared`
rows (Groceries/Household/Eating Out/France since the agreed cutoffs); the prior
Dad settlement is consumed correctly by the new grouping.

**Edge to verify during implementation:** a pre-existing `partner`-split row
(Golf, `ownershipType='me'`, no `ownershipContactId`, `partnerShare ≈ −463.24`)
will attribute to the sole partner (Alex) under the rule. So the real prod Alex
balance lands at **≈ $10,850** (`18,811.58 + 463.24 − 8,425`), not exactly
$10,386.58. Confirm that Golf row is genuinely an Alex split (vs. mis-set) when
verifying; the exact headline depends on it. The unit-test fixtures use synthetic
numbers and are unaffected.
