# Email-Vendor Item Coverage — Design (SP2)

**Date:** 2026-06-03
**Status:** Approved (design)
**Sub-project:** 2 of 3 in the "item-level categorization shrinks the review queue" effort.
Depends on SP1 (item-review mechanic, #541). SP3 (#544) shipped the photo-attach path.

## Problem

Apple/Google/Uber **email** receipts (Gmail scan, email-paste, image-upload) don't
clear review via the SP1 mechanic, because their items never satisfy the bar
(`category_override` OR `inferred_category && confidence >= 80`) and/or never get
an accepted link to a transaction. Only the PDF import path is fully wired
(match → categorize → recompute). Five concrete gaps:

1. **Gmail scan never categorizes.** `scanReceipts.ts` calls
   `matchReceiptOrderToTransactions` but never `categorizeAndApplyReceiptItems`;
   items land with `confidence = null`.
2. **Categorizer skips already-categorized items.** `categorizeReceiptItemsWithAi`
   filters `{ inferredCategory: null }` (`categorizeReceiptItems.ts:114`), so items
   that a deterministic parser (Apple/Google/Uber) already gave a category but no
   confidence are never assigned a confidence → can never pass the bar.
3. **Paste/image routes never match.** The email-paste and image-upload handlers
   in `externalOrders.ts` categorize but never call
   `matchReceiptOrderToTransactions` → no accepted link → recompute is a no-op.
4. **Sub-85 matches stay `suggested`.** Recompute reads accepted links only, so a
   weak match never clears. (Intentional; not changing.)
5. **Uber collapses to `other`.** The extraction prompt schema lists only
   `amazon|apple|google|other`; `parseVendor` drops `uber`/`uber_eats` → no vendor
   pattern match on the paste/image path.

## Decisions (from brainstorming)

- **Gap 2 — broaden the categorizer:** change the item filter from
  `{ inferredCategory: null }` to `{ confidence: null }`, so any item lacking a
  confidence (including deterministically-parsed ones) gets categorized. AI assigns
  category + confidence; this may override a bootstrap deterministic category —
  accepted, and consistent with how Amazon/Costco items are categorized.
- **Gap 4 — no link-policy change:** keep the ≥85 auto-accept threshold. Strong
  matches auto-clear; weak ones stay `suggested` for manual confirm.

## Goal & non-goals

**Goal:** Apple/Google/Uber email-receipt items (scan, paste, image) get a
confidence and, when their order strongly matches a transaction, clear that
transaction from review via SP1 — matching the already-complete PDF path.

**Non-goals:** No link-policy/threshold change. No new UI. No PDF/HEIC changes.
No surfacing of `suggested` links for one-tap accept (separate future work).
Costco prompt-schema fidelity is out of scope (SP2 = apple/google/uber).

## Changes (all mechanical, against the PDF-path pattern)

### A. Broaden categorizer — `backend/src/import/categorizeReceiptItems.ts`
`categorizeReceiptItemsWithAi`'s `itemWhere` changes from `{ inferredCategory: null }`
to `{ confidence: null }`. Items with a category but no confidence are now
processed and get both fields written. (`confidence` is a DECIMAL column stored as
string/null; `{ confidence: null }` matches NULL rows — do not compare to `''`.)

### B. Gmail scan categorize — `backend/src/integrations/scanReceipts.ts`
After the existing `matchReceiptOrderToTransactions(...)` call for a newly created
order, add `await categorizeAndApplyReceiptItems({ householdId, orderId })`
(best-effort; it already triggers `recomputeTransactionsReviewFromItems`). Order:
match → categorize, so the final recompute (inside categorize) sees both the link
and the confidences.

### C. Match into paste/image routes — `backend/src/routes/externalOrders.ts`
The email-paste (`import-text`) and image-upload (`import-image`) handlers already
call `categorizeAndApplyReceiptItems`. Add
`await matchReceiptOrderToTransactions({ externalOrderId: order.id, householdId })`
for the created order. Place it so a recompute runs after BOTH a link exists and
items have confidence (e.g. categorize then match — match's internal recompute
runs last; or match then categorize). Mirror the PDF path's order (match then
categorize) for consistency.

### D. Vendor fidelity — `backend/src/ai/extractReceiptItems.ts`
Add `uber` and `uber_eats` to the extraction prompt's `vendor` schema and to
`parseVendor`'s allowlist, so a pasted/photographed Uber receipt extracts as the
right vendor and matches `VENDOR_MERCHANT_PATTERNS`. (Gmail scan keeps its
sender-based `uberVendorOverride`.)

### E. No change (Gap 4)
`matchReceiptToTransactions.ts` auto-accept logic and `transactionIdsForOrder`
(accepted-only) are untouched. The recompute trigger already lives inside `match`
and `categorize`.

## Resulting path per source
- **Gmail scan:** persist (inline) → match → **categorize (new)** → SP1 clears strong matches.
- **email-paste / image:** persist → **match (new)** → categorize → SP1 clears.
- **PDF / Amazon / photo-attach:** unchanged (already complete).

## Testing
- **Broadened categorizer:** an item with `inferredCategory` set + `confidence = null`
  is processed and gets a numeric confidence (was previously skipped). An item that
  already has a confidence is NOT re-processed.
- **Scan path:** a deterministically-parsed order (e.g. Uber ride, category
  'Transport', confidence null) linked to a strongly-matching transaction → after
  scan's match+categorize, items have confidence and the transaction's `reviewFlag`
  clears. (Inject the categorizer's `openaiCaller`; no network.)
- **Paste/image path:** an order whose items are high-confidence + strong txn match
  → after match is wired in, an accepted link forms and the transaction clears.
- **Weak match:** score < 85 → `suggested` link → transaction stays in review (no regression).
- **Vendor:** `parseVendor('uber')` → `'uber'`, `parseVendor('uber_eats')` → `'uber_eats'`;
  prompt schema includes them.

## Files
**Modified:**
- `backend/src/import/categorizeReceiptItems.ts` — filter `inferredCategory:null` → `confidence:null`.
- `backend/src/integrations/scanReceipts.ts` — add categorize after match.
- `backend/src/routes/externalOrders.ts` — add match to paste + image handlers.
- `backend/src/ai/extractReceiptItems.ts` — add uber/uber_eats to prompt schema + parseVendor.
- Tests: `backend/test/categorizeReceiptItemsConfidence.test.ts` (new, broaden), plus an
  integration test for the scan/paste clear behavior (new or appended).

**Unchanged on purpose:** `matchReceiptToTransactions.ts`, SP1 mechanic, the PDF path.

## Follow-ups
- Surface `suggested` links for one-tap accept in the review UI.
- Costco prompt-schema vendor fidelity.
- Preserve deterministic category while only filling confidence (if AI override proves wrong).
