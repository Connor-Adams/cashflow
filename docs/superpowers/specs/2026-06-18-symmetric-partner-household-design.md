# Make the Linked Partner Real — Symmetric Household via Projection

**Date:** 2026-06-18
**Status:** Design — approved for planning
**Approach:** A (projection layer + sharing onboarding), chosen over B (Counterparty
relational rework) and C (connect + onboard only).

## Problem

Connor has a linked partner account (household 1: Alex, `alexmcphail98@gmail.com`,
user 3, role `member`, joined 2026-06-17). Linking *worked* — but the household
delivers almost nothing on top of it:

- **Two disconnected partner identities.** The partner exists twice with no link
  between them:
  1. `HouseholdMember` — the login account (user 3).
  2. `Contact.isPartner` — the fairness/split target (Contact #7 "Alex").
  `Contact` has no FK to `users`. Fairness math, splits, and settlements all key
  off the *Contact*, never the linked member. They line up by name coincidence.
  Linking a real account does **nothing** for the fairness engine today.
- **Empty shared surface.** 0 of 29 accounts are `visibility='shared'`, so the
  partner who logs in sees nothing. 5 of ~4,976 transactions are split. The house
  is entirely one-sided: all 4,976 txns `created_by_user_id=1`; Alex has imported
  zero.
- **Asymmetric model.** `partnerFairness.ts` hardcodes "me = uploader, partner =
  owes-back". `myShareAmount`/`partnerShareAmount` are stored absolute from the
  owner's POV. A partner viewing the same data has no correct lens.

**Target experience:** a symmetric "us" — both partners are peers in a shared
world, both see/edit shared data, shares read correctly from each side, splitting
is effortless rather than per-transaction manual.

## Primitives-spine check (per CLAUDE.md build rule)

This is **not** a new primitive — it extends existing ones:

- `Contact.userId` extends **Counterparty** (Contact is a physical table the
  Counterparty primitive folds): a new field linking the counterparty to a login.
  No new status machine.
- Viewer-relative shares are a **derivation/view** over **Transaction** — no
  table, a read-path projection.
- `SplitRule` is a household-owned **rule/config** that feeds Transaction share
  computation. It has CRUD but **no status machine** (no lifecycle transitions),
  so it is a config input to an existing primitive's derivation, not a 14th
  primitive. Flagged here for the reviewer; if a reviewer judges it a status
  machine, fold it instead — but it is plain match→action config.

Approach B (relational `TransactionShare`, folding `HouseholdMember` +
`Contact.isPartner` into one Counterparty identity, N-party support) **is** a spine
change and is explicitly out of scope — YAGNI with exactly two people.

## Design

### Component 1 — One partner identity (the spine)

**Schema:** add `Contact.userId` — nullable FK to `users`, unique per
`(householdId, userId)` where non-null. This links the fairness/split Contact to
the actual login account.

**Invite-accept hook** (`backend/src/routes/auth.ts:128–135`, inside the existing
`sequelize.transaction`): after `HouseholdMember.create(...)`, resolve a Contact
for the joining user:
- If the household already has an unlinked `isPartner` Contact, adopt it
  (set `userId = createdUser.id`).
- Otherwise auto-create a Contact (`isPartner = true`, `userId = createdUser.id`,
  `name` from the user's `display_name`).

**Backfill migration:** for each existing household, if there is exactly one
`isPartner` Contact and exactly one non-owner member, link them. Otherwise leave
`userId` null and rely on the manual control below. (Household 1 satisfies the
auto-link case: Contact #7 ↔ user 3.)

**Manual link control:** Settings → Members gains a "link to member" affordance on
each unlinked `isPartner` contact, for households the backfill could not resolve.

### Component 2 — Viewer-relative projection (the symmetric core)

The single behavioral change that makes the model symmetric. **No stored data
changes** — shares stay absolute; the read path projects them per viewer.

Per transaction, relative to the viewing user `V`:

```
myShare(V)      = txn.created_by_user_id == V.userId ? myShareAmount : partnerShareAmount
partnerShare(V) = the other one
```

**Why `created_by_user_id` and not a global swap:** in the single-payer model the
creator is the payer. Keying off the creator makes the projection correct
per-transaction as soon as both partners import their own data — Connor's txns flip
for Alex, Alex's txns flip for Connor, automatically. A global me/partner swap would
break the moment the house stops being one-sided.

**Hook points:**
- `backend/src/summary/partnerFairness.ts` — `buildFairnessByCurrency`
  (lines 316–423) is pure; thread a `viewerUserId` parameter and apply the
  projection when assembling `SharedTxnRow` shares in `loadSharedTxns`
  (`partner.ts:89–194`).
- `backend/src/routes/partner.ts` — the `GET /fairness` caller (lines 238–255)
  already reads `req.auth.userId` (for `excludeNonPartnerInflows`); pass it down.
- Transactions list + `PartnerFairnessPage` display `myShare`/`partnerShare`
  through the same projection.

**Direction labels** ("you owe" ↔ "owes you") resolve per viewer.

**Invariant:** `myShare + partnerShare` and `|balance|` are identical for both
viewers; only sign/direction mirror.

### Component 3 — Sharing onboarding + partner home

**Share accounts:** reuse the existing `accounts.visibility` ('shared' | 'private')
and the existing `visibleWhere` / `visibleAccountWhere` / `visibleTransactionWhere`
row-level guards (`backend/src/auth/scope.ts`). Today 0 accounts are shared.
- A "share these accounts" step (Settings / Members) lets a member multi-select
  which of their accounts become `visibility='shared'`.
- Nudged from the partner-empty state.

**Partner home:** a landing surface for a logged-in member showing, viewer-relative:
shared spend, current balance, what you owe / are owed, recent shared transactions.
Empty-state when nothing is shared yet, linking to the share-accounts step.

### Component 4 — Effortless splitting

**Bulk split** on the transactions list: select N transactions → apply a split
(50/50 · custom pct · ownership me/partner/shared). Applies by setting the override
fields and calling the existing `recomputeTransactionAmounts`
(`backend/src/import/calculateShares.ts:78–156`).

**Split rules** — new `SplitRule` model (household-scoped):
- Match criteria: any of category / merchant / account / amount ≥ threshold.
- Action: split type + pct (e.g. "groceries ≥ $50 → 60/40").
- Applied at import time and re-runnable over history.

**Provenance & priority** in `recomputeTransactionAmounts`: extend the existing
priority (`override > auto > default 'me'`) to `override > rule > auto > default`.
Add `Transaction.splitRuleId` (nullable FK) so a rule-applied split is
distinguishable from a manual one, and **re-running rules never clobbers a manual
`pctOverride`.**

## Data model changes

| Change | Table | Notes |
|---|---|---|
| `userId` nullable FK → `users` | `contacts` | unique per `(household_id, user_id)` |
| new table | `split_rules` | household-scoped match→action config |
| `splitRuleId` nullable FK → `split_rules` | `transactions` | split provenance |
| backfill | — | link existing `isPartner` contact ↔ member where resolvable |

All Sequelize must run on both SQLite and Postgres (dual-dialect).

## Out of scope (YAGNI)

- N-party / relational `TransactionShare`, folding member + contact into one
  Counterparty identity (approach B — a spine change).
- Reimbursements revamp and settle-up reminders/nudges — separate specs.

## Testing

- **Projection:** viewers A and B see mirrored shares; `myShare + partnerShare` and
  `|balance|` invariant holds; sign/direction mirror. Cover the mixed case (some
  txns created by each member) once data is two-sided.
- **Invite-accept:** auto-creates and links a Contact; adopts an existing unlinked
  `isPartner` contact when present.
- **Backfill:** links the right contact↔member in the one-partner/one-member case;
  leaves `userId` null and surfaces the manual control otherwise.
- **Split rules:** rule application sets the right pct; priority holds — a manual
  override survives a rule re-run; `splitRuleId` provenance recorded.
- **Visibility:** a member sees shared accounts/transactions only, never the other
  member's private ones (`visibleWhere` enforcement).

## Verified hook points (current code)

| Hook | Location |
|---|---|
| Invite accept (member create + invite update) | `backend/src/routes/auth.ts:128–135` |
| Contact model (no user FK; has `isPartner`, `isSelf`) | `backend/src/models/Contact.ts` |
| Fairness aggregation (pure) | `backend/src/summary/partnerFairness.ts:316–423` |
| Fairness caller (has `req.auth.userId`) | `backend/src/routes/partner.ts:238–255` |
| Share compute (priority override>auto>default) | `backend/src/import/calculateShares.ts:78–156` |
| Split override PATCH | `backend/src/routes/transactions.ts:542–558` |
| Row-level visibility guards | `backend/src/auth/scope.ts` |

## Planning addendum (discovered while reading the fairness code)

Two refinements to Component 2, found by reading `partnerFairness.ts` /
`partner.ts` during plan-writing:

1. **Balance projection is not a field-swap.** `myShareAmount` +
   `partnerShareAmount` = `amount` (they are portions, not negatives of each
   other), so swapping the two per row and reusing `balance = -partnerShareTotal
   + settlements` produces a *wrong* balance. The correct per-row balance
   contribution for viewer `V` is:

   ```
   balanceContribution_V(row) = (row.payerUserId == V) ? -partnerShareAmount : +partnerShareAmount
   ```

   (Verified: a Connor-paid row with `partnerShareAmount = -50` → Connor `+50`
   "partner owes me", Alex `-50` "I owe partner".) The *display* swap
   (`myShare`/`partnerShare` in category breakdown & largest-shared) is a
   separate, independent transform. `SharedTxnRow` gains `payerUserId`
   (= `created_by_user_id`); `buildFairnessByCurrency` / `buildFairnessMonthly`
   take a `viewerUserId` and compute balance from the contribution formula, not
   from the swapped totals.

2. **Settlements need payer attribution.** `PartnerSettlement` has `contactId` +
   `direction` (`i_paid_partner` / `partner_paid_me`) but **no user FK** — the
   direction is implicitly owner-relative. For a symmetric view (when the partner
   records a settlement) the direction must project per viewer. Add
   `PartnerSettlement.recordedByUserId` (the user whose "i" the direction refers
   to; default = the household owner on backfill). Projection: when
   `viewerUserId != recordedByUserId`, swap `iPaid ↔ partnerPaid` for that
   settlement before rolling up. This becomes part of the spine (Component 1).
