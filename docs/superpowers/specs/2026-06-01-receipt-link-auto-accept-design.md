# Auto-accept high-confidence receipt→transaction links

**Date:** 2026-06-01
**Status:** Approved, pending implementation
**Primitive touched:** Transaction ↔ ExternalOrder link (the `TransactionOrderLink`
status machine: `suggested → accepted | rejected`). No new primitive; this
changes one transition's trigger.

## Problem

Uploaded receipts (`ExternalOrder`) are matched to bank-statement
`Transaction`s by `backend/src/import/matchReceiptToTransactions.ts`, which
creates `TransactionOrderLink` rows. A receipt only displays as **Linked** when
one of its links has `status='accepted'` (`deriveLinkStatus`,
`backend/src/routes/externalOrders.ts:35-37`: `accepted → 'linked'`,
`suggested → 'needs_match'`, else `'orphan'`).

The matcher always creates links with `status='suggested'`. The only UI that can
flip a link to `accepted` is `frontend/src/pages/AmazonPage.tsx`, which lists
**only** `vendor='amazon'` orders. `ReceiptsList.tsx` renders link status as a
read-only badge with no accept control. Consequence: high-confidence non-Amazon
matches (Costco, Apple, Google) are stranded as `suggested` forever and show as
"needs match".

### Production evidence (household 1, 2026-06-01)

Two Costco receipts the matcher had already matched correctly, all stuck
`suggested`:

| link id | order | → txn | amount | confidence | was |
|--------:|------:|------:|-------:|-----------:|-----|
| 65 | 398 | 983 | 1863.72 | 90 | suggested |
| 66 | 398 | 1449 | 1100.00 | 90 | suggested (split tender) |
| 67 | 399 | 1446 | 947.04 | 90 | suggested |

(Order 398 is a split-tender receipt; both legs matched.) These three were
manually accepted as a one-off fix prior to this work; this spec prevents
recurrence and backfills any others.

## Goal

Clean, unambiguous, high-confidence matches link with **zero clicks**.
Ambiguous or weak matches stay `suggested`.

## Design

### 1. Auto-accept decision (pure helper)

In `backend/src/import/matchReceiptToTransactions.ts`, add:

```ts
const AUTO_ACCEPT_THRESHOLD = 85; // exact-amount match baseline is 90 (50 amount + 25 date + 15 vendor)
const AUTO_ACCEPT_MARGIN = 10;    // best must lead runner-up by more than this to be unambiguous

// sortedConfidences: the confidences of the candidates for ONE payment, already
// filtered to >= MATCH_CONFIDENCE_THRESHOLD and sorted descending. Pure predicate,
// no Transaction coupling — trivially unit-testable.
export function decideAutoAccept(sortedConfidences: number[]): boolean {
  if (sortedConfidences.length === 0) return false;
  if (sortedConfidences[0] < AUTO_ACCEPT_THRESHOLD) return false;
  if (sortedConfidences.length === 1) return true;
  return sortedConfidences[0] - sortedConfidences[1] > AUTO_ACCEPT_MARGIN;
}
```

Call site: `decideAutoAccept(scored.map((s) => s.confidence))`.

Rationale for the constants: the scoring components are amount (≤$0.50 ⇒ 50,
≤$2 ⇒ 35, else −25), date (0–5d after ⇒ 25, ±2d ⇒ 15, >10d ⇒ −15), vendor (15),
last4 (20). An exact-amount + in-date + vendor match scores 90; an
amount-within-$2-only match tops out around 65–75. So `85` admits the genuine
matches and excludes the fuzzy ones. The dominant failure mode is **ambiguity**
— two same-amount transactions in the ±7d window both scoring 90 — which the
margin guard rejects (best does not lead by >10), leaving them `suggested`.

### 2. Wire it into the matcher

`matchReceiptOrderToTransactions` already computes, per payment, a `scored`
array (filtered ≥ threshold, sorted desc) and takes `best = scored[0]`. Change
the status assignment:

- **Create branch** (`findOrCreate` defaults): `status: decideAutoAccept(scored) ? 'accepted' : 'suggested'`.
- **Update branch** (existing link found): only when the existing
  `link.status === 'suggested'`, refresh confidence/reason/amount as today, and
  **additionally** set `status='accepted'` if `decideAutoAccept(scored)` is now
  true. Never downgrade an `accepted`; never touch a `rejected`.

This makes re-running the matcher idempotent and monotonic for the accept
transition: `suggested` may advance to `accepted`; nothing regresses.

### 3. Backfill script

`backend/scripts/backfill-receipt-link-acceptance.ts` (sibling of the existing
`backend/scripts/*.ts` like `inspect-fingerprint-dups.ts`):

- Find every `ExternalOrder` that has at least one `TransactionOrderLink` with
  `status='suggested'`.
- For each, call `matchReceiptOrderToTransactions({ externalOrderId, householdId })`.
  Because the matcher's update branch now upgrades qualifying suggested links,
  re-running **is** the backfill — no rule duplication.
- Dry-run by default; `--commit` performs writes. Print per-order: links that
  would upgrade `suggested → accepted` vs left `suggested`.
- Read prod via `DATABASE_URL` (Railway `DATABASE_PUBLIC_URL`). Per project
  convention, never run against local sqlite.

Idempotent and safe to re-run (monotonic upgrade only).

## Out of scope

- **Manual Accept/Reject UI for non-Amazon receipts.** Chosen explicitly:
  auto-accept only. Ambiguous/low-confidence non-Amazon links remain `suggested`
  with no resolution affordance. Rare (needs two ≥85 candidates within 10 pts).
  Revisit if it bites.
- **`backend/src/amazon/matcher.ts` (`runAmazonMatching`).** Amazon has its own
  matcher and its own accept UI; unchanged here. Auto-accept parity for Amazon is
  a separate decision.
- **Vendor-neutral `/api/order-links/*` endpoint fold.** Only needed if we ship
  the manual UI; deferred with it.

## Testing (TDD)

Unit — `decideAutoAccept`:
1. single candidate, conf ≥ 85 → true.
2. single candidate, conf < 85 → false.
3. two candidates, 90 vs 90 (margin 0) → false (ambiguous).
4. two candidates, 90 vs 75 (margin 15) → true.
5. two candidates, 90 vs 82 (margin 8) → false.
6. empty → false.

Integration — `matchReceiptOrderToTransactions` (in-memory sqlite, per project
test convention):
7. one exact-amount Costco txn in window → link created `accepted`.
8. two same-amount Costco txns in window → best link created `suggested`.
9. amount-within-$2-only match (conf < 85) → `suggested`.
10. re-run over a stale `suggested` link that now qualifies → upgraded to `accepted`.
11. re-run does NOT downgrade an existing `accepted`, does NOT resurrect a `rejected`.
12. split-tender receipt, both tenders unambiguous (order-398 shape) → both links `accepted`.

Backfill script: covered by the matcher integration tests (it is a thin loop
over the same call); a smoke test asserts it selects only orders with suggested
links and is a no-op without `--commit`.

## Verification

After deploy, run `backend/scripts/diagnose-costco-receipt-links.ts` (read-only)
against prod and confirm newly imported clean Costco/receipt links land
`accepted`. Run the backfill in dry-run first, eyeball the upgrade list, then
`--commit`.
