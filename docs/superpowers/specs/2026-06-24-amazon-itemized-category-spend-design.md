# Amazon Itemized Category Spend — Design

**Date:** 2026-06-24
**Status:** Draft (awaiting review)
**Owner:** Connor

## Problem

Hundreds of bank transactions show up as an opaque "Amazon" blob, giving no
insight into *what* was actually bought and making category-level analysis
useless. The goal: Amazon (and any itemized-order vendor) spend should decompose
into the categories of the items actually purchased — e.g. one $200 Amazon charge
that bought an espresso machine + books shows as Coffee $150 + Books $50, not one
"Amazon" lump.

## Key finding: the machinery already exists; the chain is broken upstream

The desired decomposition (`splitTxnByItems()`) is already built and already
powers dashboard tiles, budgets, monthly rollups, and insights. It is **not**
wired into the reporting API, but that is *not* the real bottleneck. Production
data (2026-06-24) shows the chain breaks earlier:

```
1. CAPTURE     email parser + bookmarklet → itemized Amazon orders   ✅ 500 orders, 746 items, 591 categorized (79%)
2. MATCH       runAmazonMatching → TransactionOrderLink              ⚠️  15 suggested / 95 txns
3. ACCEPT      link.status = 'accepted'                              ❌  0 accepted (13 of 15 sit at confidence ≥85)
4. CATEGORIZE  per-item inferredCategory                            ✅ healthy
5. REPORT      splitTxnByItems → spend-by-category                  ❌ never wired into /api/v1/spending/by-category
```

Two upstream breaks make the report wire useless on its own:

- **Accept gap (cheapest fix):** 13 of 15 Amazon links are confidence ≥85 yet
  0 are accepted. `runAmazonMatching` only ever writes `status='suggested'`. The
  receipt-matching path (`matchReceiptToTransactions.ts`) already auto-accepts
  via `decideAutoAccept()` (threshold 85, margin 10); the Amazon order path
  doesn't. `loadItemAllocationContext()` only loads `status='accepted'` links, so
  decomposition sees nothing.
- **Email orders unmatchable:** `gmail-scan:ai` orders (103) carry 0/103
  `payment_last4` and 1/103 `order_date`. With no date and no last4, the matcher
  scores on amount alone, ties against 500 orders, and `selectMatchCandidates`
  rejects the ambiguous result. `amazon_report` orders (397) are clean (388
  last4, 397 dates) by contrast. The email parser's weak field extraction is the
  direct cause.

## Primitives-spine check

No new primitive. This extends existing machinery only:

- **Transaction** ↔ **Document** (ExternalOrder) link is the existing
  `TransactionOrderLink` status machine (`suggested → accepted/rejected`). Phase 1
  only changes *who* sets `accepted` (auto vs manual), not the machine.
- Item→category decomposition is a **derivation** (`splitTxnByItems`), not a new
  table. Phase 2 surfaces an existing derivation through a new query path.
- Phase 3 improves field extraction into existing columns
  (`external_orders.order_date`, `payment_last4`, `tax`, `subtotal`).

No new status machine. Not a spine change.

## Scope

One spec, three phases, shipped in order. Phases 1+2 deliver visible insight
fast; Phase 3 grows the population that 1+2 operate on.

---

### Phase 1 — Close the accept loop

**Goal:** high-confidence Amazon order links auto-accept; the rest become a
frictionless one-click review queue.

**Backend.** Reuse the existing `decideAutoAccept(sortedConfidences)` from
`backend/src/import/matchReceiptToTransactions.ts` (threshold 85, margin 10) in
the Amazon order→transaction path. In `runAmazonMatching` /
`upsertSuggestedOrderLink` (`backend/src/amazon/matcher.ts`), once candidates for
a transaction are scored and selected, if the best candidate is ≥85 **and** leads
the runner-up by >10, write `status='accepted'` instead of `'suggested'`. Links
in the 75–84 band, or ambiguous ≥85 ties, stay `'suggested'`.

- Auto-accepting a link must trigger the same downstream recompute that manual
  accept does today (`routes/amazon.ts:361,409` →
  `recomputeTransactionReviewFromItems`). Factor the post-accept side effects so
  both the auto path and the manual path call one function — no divergence.
- Idempotent: re-running matching must not flip an already-accepted or
  user-rejected link. Respect existing `accepted`/`rejected` rows; only promote
  `suggested → accepted` for fresh auto-qualifying links.

**Frontend.** A review surface for the 75–84 band (and ambiguous ≥85): list of
pending Amazon links with the candidate order's items, one-click Accept / Reject
hitting the existing `PATCH /api/external-orders/:id/transaction-link/:linkId`.
Reuse the existing receipt/order review components where they fit.

**Backfill.** A one-shot pass over existing `suggested` Amazon links applying the
same `decideAutoAccept` rule, so the ~13 current ≥85 links light up without
waiting for re-matching. Idempotent and re-runnable.

**Outcome:** ~13 transactions immediately gain accepted links to already-
categorized orders.

---

### Phase 2 — Wire `splitTxnByItems` into reporting

**Goal:** `/api/v1/spending/by-category` and the frontend spend-by-category view
decompose itemized, accepted-linked transactions into per-item-category spend;
everything else falls back to the transaction's own `finalCategory`.

**Backend.** In `backend/src/routes/reporting.ts`
(`aggregateSpendByCategoryId` + `GET /api/v1/spending/by-category`):

- Load item-allocation context for the reporting window via
  `loadItemAllocationContext()` (the same join used by the dashboard).
- For each transaction: if it has an accepted link to an itemized order, replace
  its single-category contribution with `splitTxnByItems()` allocations; else
  contribute its `finalCategoryId` amount as today.
- Allocations must reconcile to the transaction amount. Confirm `splitTxnByItems`
  assigns any uncategorized/rounding remainder to the transaction's
  `finalCategory` (verify, and add a test asserting Σallocations == txn amount).
- Feed the resulting per-category map into the existing `rollupByCategoryId()`
  hierarchy rollup unchanged.

**Reconciliation invariant (load-bearing):** total spend reported must be
identical before and after this change — only its *distribution across
categories* shifts. A test must assert the grand total is unchanged for a fixed
dataset.

**Nesting note.** Decomposed items land in their natural top-level categories
(Coffee, Home, Books). The prior category-nesting reporting audit (2026-06-18)
found some surfaces use final-category only; the `rollupByCategoryId` path used
here already rolls up the hierarchy, so this surface nests correctly. A dedicated
"Amazon spend broken down by item category" drilldown is explicitly **out of
scope** for this spec (revisit if the flat decomposition proves insufficient).

**Frontend.** The spend-by-category view consumes the enriched endpoint with no
shape change if the response contract is preserved. Verify the contract; if a
decomposed row needs a provenance marker (e.g. "via items"), add it additively.

**Outcome:** Amazon (and Costco, and any itemized vendor) spend shows real
category breakdown in reporting for every accepted-linked transaction.

---

### Phase 3 — Grow the matchable pool

**Goal:** more transactions earn accepted links by raising email-order data
quality and matcher recall. Each new link flows straight into Phase 2's report.

**Email parser** (`backend/src/integrations/parsers/amazon.ts`):

- **Fix the dropped fields:** the parser regex-matches `tax` and `shipping` then
  returns `subtotal:null, tax:null`, dumping them into a notes string. Populate
  the structured `tax` / `subtotal` (and `shipping`) fields on the returned
  `ExtractedReceiptOrder` instead.
- **Extract `order_date` and `payment_last4` reliably** — these are the fields
  gmail-scan orders are missing (0/103 last4, 1/103 dates) and are exactly what
  the matcher scores on. Harden `DATE_RE` / `LAST4_RE` against real Amazon email
  layouts; add fixtures from real (sanitized) emails.
- **Currency detection** instead of hardcoded `null`.
- **More formats:** ship-confirm, digital (Kindle/Audible/Prime Video), and
  refund/cancellation emails (negative amounts). Parsers should still return
  `null` when uncertain (bias preserved: a wrong order is worse than an AI call).
- The AI fallback (`ai/extractReceiptItems`) should be prompted/validated to
  return `orderDate` + `last4` when present, since gmail-scan orders flow through
  it.

**Matcher recall** (`backend/src/amazon/matcher.ts`): of 80 unlinked txns, 37
have a plausible amount+date order candidate but get no suggestion — ambiguity
rejection in `selectMatchCandidates`. Investigate and tune tie-breaking (e.g. use
last4/date as a tiebreaker before rejecting), and consider the Amazon
multi-shipment reality (one order → several card charges; one charge → partial
order). Any recall change must not regress the false-link rate — measure on prod
fixtures before/after.

**Outcome:** the accepted-linked population grows over time; Phase 2's report
gets richer with no further reporting changes.

---

## Testing

- **Phase 1:** unit tests for the Amazon-path auto-accept decision (≥85+margin →
  accepted; 75–84 → suggested; ambiguous ≥85 tie → suggested); idempotency
  (re-run doesn't flip accepted/rejected); auto and manual accept invoke the same
  post-accept recompute. Backfill test on a seeded set of suggested links.
- **Phase 2:** reconciliation test (Σ item allocations == txn amount; grand total
  unchanged vs pre-change); mixed-order decomposition splits across categories;
  unlinked/non-itemized txns fall back to `finalCategory`; rollup hierarchy
  intact.
- **Phase 3:** parser fixtures (auto-confirm, ship-confirm, digital, refund) assert
  extracted `orderDate`/`last4`/`tax`/`subtotal`/`currency`/items; matcher recall
  regression on prod-derived fixtures (no increase in false links).
- Dual-dialect: all backend tests must pass on SQLite and Postgres.

## Risks

- **Wrong auto-links** at ≥85: mitigated by the margin>10 unambiguity rule
  (existing precedent) and reversibility (user can reject; report recomputes).
- **Report total drift** in Phase 2: guarded by the reconciliation invariant test.
- **Matcher recall vs precision** in Phase 3: measured on fixtures; recall changes
  gated on no false-link regression.

## Out of scope

- A per-merchant "Amazon → item-category" drilldown view (flat decomposition
  first; revisit if insufficient).
- Apple email enrichment (separate effort; deferred fine Apple sub-categorization
  is blocked on Apple line-item data).
- Removing the legacy/dead `backend/src/amazon/parseAmazonReceiptEmail.ts` (note
  it; out of scope here).
