# Generic Receipt Attach → Itemize → Clear — Design

**Date:** 2026-06-03
**Status:** Approved (design)
**Sub-project:** 3 of 3 in the "item-level categorization shrinks the review queue" effort.
Depends on SP1 (item-review mechanic, merged PR #541).

## Problem

The "attach a photo of any receipt and have it itemize + clear review" outcome is
*mostly already plumbed* but blocked by two backend gaps, and it isn't
discoverable where people actually clear the queue.

What already works:
- `POST /api/transactions/:id/receipts` attaches an image to **any** transaction
  (no `txnType`/source gate) — statement-imported, manual, anything.
- `extractReceiptFromImage` (vision) is **vendor-agnostic** — any merchant photo
  is sent to the model.
- SP1's `recomputeTransactionsReviewFromItems` is already called at the end of
  `POST /receipts/:id/analyze`.

The two gaps that block clearing:

- **Gap A — no confidence after analyze.** `analyze` → `persistExtractedOrder`
  stores items with an `inferredCategory` from the extraction LLM but **never
  runs the categorization pass**, so `confidence` stays null. SP1's `itemMeetsBar`
  requires `confidence >= threshold`, so photo-attached items can never clear.
- **Gap B — generic receipts never link.** `matchReceiptOrderToTransactions`
  only auto-links *known* vendors (`VENDOR_MERCHANT_PATTERNS`:
  amazon/apple/google/costco/uber). A normal store receipt extracts as vendor
  `other`, matches nothing, creates **zero** accepted links → recompute has no
  transaction to act on. But the user already told us the transaction by
  attaching the receipt to it; fuzzy matching is unnecessary in that case.

Plus a discoverability gap: the only attach affordance is a button on a
TransactionsPage row. There is no entry point from the review inbox, and no
camera-first capture.

## Goal & non-goals

**Goal:** Attaching (or snapping) a receipt photo on any transaction extracts its
items, categorizes them, links the order directly to that transaction, and — via
SP1 — clears the transaction from review when every item passes the bar.
Discoverable from the review inbox with a camera-first capture path.

**Non-goals (this cut):**
- No new extraction/OCR pipeline — the existing vision extractor is reused as-is.
- No PDF or HEIC support in the analyze path (existing image-only limit kept).
- No soft "photo total ≠ transaction amount" mismatch warning (post-MVP polish).
- No change to SP1's clear mechanic, the per-item bar, or budget behavior.

## Design decisions (settled during brainstorming)

- **Confidence source:** run the existing `categorizeAndApplyReceiptItems` pass
  after extraction (consistent with every other receipt path; reuses
  household-category-reuse logic) — *not* an extraction-prompt confidence field.
- **Linking:** when a receipt has a `transactionId`, link the extracted order
  **directly** to that transaction (accepted), bypassing fuzzy matching.
- **Photo is authoritative (conflict rule):** attaching a photo supersedes
  whatever order was linked to that transaction — any existing **accepted**
  `TransactionOrderLink` on it is set `rejected` (order row preserved, reversible)
  so the photo's order is the single accepted order. This intentionally
  supersedes an Amazon/import order if the user attaches a photo.
- **Scope:** backend wiring + camera capture + a review-inbox entry point.

## Architecture — backend

### `POST /api/receipts/:id/analyze` new flow

```
1. (existing) auth, OpenAI gate, load receipt + parent txn, read image buffer,
   reject non-image mime.
2. (existing) extracted = extractReceiptFromImage(dataUrl)
3. (existing) { order, created } = persistExtractedOrder(extracted, { source: 'receipt-analyze' })
4. (existing) update receipt.externalOrderId / extractedNote; clear prior SUGGESTED links of the old order.
5. NEW — anchor to the receipt's own transaction when known:
     if (receipt.transactionId != null) {
       await supersedeAcceptedOrderLinks(receipt.transactionId, order.id);  // reject other accepted links on this txn
       await linkOrderToTransaction(order.id, receipt.transactionId);       // findOrCreate accepted link
     } else {
       await matchReceiptOrderToTransactions({ externalOrderId: order.id, householdId });  // existing fuzzy fallback
     }
6. NEW — categorize so items get confidence:
     await categorizeAndApplyReceiptItems({ householdId, orderId: order.id });
     // (this call already triggers recomputeTransactionsReviewFromItems for the order's txns)
7. (existing/keep) one explicit recompute as a safety net:
     await recomputeTransactionsReviewFromItems(await transactionIdsForOrder(order.id));
8. (existing) Costco name expansion best-effort.
9. NEW — response includes itemCount so the UI can report "couldn't read items".
```

### New helpers

```ts
// supersede: set every OTHER accepted link on this txn to 'rejected'
async function supersedeAcceptedOrderLinks(transactionId: number, keepOrderId: number): Promise<void> {
  await TransactionOrderLink.update(
    { status: 'rejected' },
    { where: { transactionId, status: 'accepted', externalOrderId: { [Op.ne]: keepOrderId } } },
  );
}

// link: findOrCreate an accepted link (idempotent on re-analyze of the same order)
async function linkOrderToTransaction(orderId: number, transactionId: number): Promise<void> {
  const [link] = await TransactionOrderLink.findOrCreate({
    where: { transactionId, externalOrderId: orderId },
    defaults: { transactionId, externalOrderId: orderId, status: 'accepted', confidence: '100', matchReason: 'receipt-attach' },
  });
  if (link.status !== 'accepted') await link.update({ status: 'accepted' });
}
```

These live alongside the analyze handler (or in `matchReceiptToTransactions.ts`
if that's the cleaner home — implementer's call based on existing structure).

### Why this clears review

After step 6, the order's items have `inferredCategory` + `confidence` (from the
categorizer). The order has an accepted link to the transaction. SP1's recompute
loads accepted-link items, runs `transactionClearsFromItems`, and flips
`reviewFlag`/`importConfidence`. Stragglers (low-confidence items) keep it in
review with SP1's inline-fix affordance.

### Edge cases

- **Zero items extracted** → `transactionClearsFromItems` is false (zero items) →
  stays in review. Response `itemCount: 0` → frontend reports failure.
- **Photo total ≠ txn amount** → link anyway (deliberate attach). No block.
- **Re-analyze** → supersede + `dedupeKey` `findOrCreate` ⇒ clean swap, single
  accepted order, no double-count.
- **No `transactionId`** (email receipt) → existing fuzzy path, unchanged.
- **Superseded Amazon link** → set `rejected`, order preserved, reversible.

## Architecture — frontend

### Camera capture

Add `capture="environment"` to the receipt-upload `<input type="file">` (existing
TransactionsPage input + the new inbox input). Mobile opens camera-first; desktop
unaffected.

### Shared attach-analyze hook

Extract the inline TransactionsPage sequence (`onReceiptPicked` →
`POST /transactions/:id/receipts`, then `onExtractReceipt` →
`POST /receipts/:id/analyze`) into one reusable hook/helper
(`useAttachAndAnalyzeReceipt` or a lib function) returning
`{ attach(file, txnId), analyzing, lastItemCount, error }`. Both TransactionsPage
and ReviewInboxPage call it — single attach-analyze path (DRY).

### Review-inbox entry point

On each `ReviewInboxPage` row, add a **"📷 Add receipt"** affordance (shown on
rows that have no items; itemized rows already have the badge/expand). Click →
camera/file picker → shared hook runs upload + analyze → inline "Analyzing…"
state → on completion re-run the inbox load (`getJson<Paginated<Transaction>>`):
- cleared transaction drops out of the inbox;
- a transaction left with stragglers shows SP1's `🧾 N items · M need review`
  badge and expands for inline fixing;
- zero items → inline "Couldn't read items — try another photo."

## Testing

**Backend integration** (`extractReceiptFromImage` + `categorizeAndApplyReceiptItems`
both injected via their `openaiCaller` seams — no network):
- Analyze on a plain statement transaction → accepted link to **that** txn, items
  carry `confidence`, `reviewFlag` cleared, `importConfidence='clean'`.
- Supersede: txn with a prior accepted (Amazon) link → after photo analyze, the
  Amazon link is `rejected`, the photo order is accepted, recompute reflects only
  the photo's items.
- Re-analyze the same receipt → single accepted order, no duplicate link, no
  double-count.
- Zero-items extraction → transaction stays in review; response `itemCount === 0`.
- Email receipt (no `transactionId`) → still uses fuzzy `matchReceiptOrderToTransactions`
  (regression guard).
- Low-confidence item → transaction stays in review (straggler).

**Frontend:**
- The receipt `<input>` carries `capture="environment"`.
- Inbox "Add receipt" → calls upload then analyze (mock both) → shows analyzing
  state → triggers inbox refetch.
- Zero-item analyze response → shows the "couldn't read items" message.
- Shared hook used by both TransactionsPage and ReviewInboxPage (no duplicated
  upload-analyze logic).

## Files

**Backend — modified:**
- `backend/src/routes/receipts.ts` — analyze flow: anchor-to-own-txn link +
  supersede + categorize pass + `itemCount` in response.
- `backend/src/import/matchReceiptToTransactions.ts` *(or receipts.ts)* —
  `supersedeAcceptedOrderLinks`, `linkOrderToTransaction` helpers.
- Test: `backend/test/receiptAnalyzeAttach.test.ts` (new).

**Frontend — modified/new:**
- `frontend/src/lib/useAttachAndAnalyzeReceipt.ts` (or equivalent) — shared hook.
- `frontend/src/pages/TransactionsPage.tsx` — `capture` attr + use shared hook.
- `frontend/src/pages/ReviewInboxPage.tsx` — "Add receipt" affordance + `capture` + use shared hook.
- Tests: `ReviewInboxPage.test.tsx` additions.

**Unchanged on purpose:** SP1's `transactionClearsFromItems`,
`recomputeTransactionReviewFromItems`, `computeReviewFlag`; the extraction prompt.

## Follow-ups (out of scope)

- SP2: verify Apple/Google/Uber email items carry category + confidence.
- PDF / HEIC support in the analyze path.
- Soft warning when photo total diverges from the transaction amount.
- Auto status promotion (e.g. → `cleared`) after itemize.
