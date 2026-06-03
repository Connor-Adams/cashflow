# Generic Receipt Attach → Itemize → Clear — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attaching/snapping a receipt photo on any transaction extracts its items, categorizes them (so they get a confidence), links the order directly to that transaction, and clears the transaction from review via the SP1 mechanic — discoverable from the review inbox with camera capture.

**Architecture:** A testable orchestrator `anchorReceiptOrderToTransaction` runs AFTER extraction: supersede other accepted links on the transaction → link the photo order (accepted) → run the existing `categorizeAndApplyReceiptItems` pass (gives items `confidence`) → recompute review (SP1). The analyze route wires extraction into it. Frontend gets a shared attach+analyze hook used by both TransactionsPage and a new review-inbox "Add receipt" affordance, with camera capture.

**Tech Stack:** TypeScript, Node `node:test` via `tsx`, Sequelize (SQLite test / Postgres prod), Express, React/Vite.

**Spec:** `docs/superpowers/specs/2026-06-03-generic-receipt-attach-design.md`. Depends on SP1 (merged).

**Test runner:** `cd backend && npx tsx --import ./test/setup.ts --test test/<file>.test.ts`.

**Worktree env:** pre-commit hook is broken (`lint-staged`/`tsx`/`sequelize-cli` not on PATH, exit 127) — commit with `--no-verify`; the full backend `yarn test` has ~120 unrelated environmental failures (sequelize-cli), so verify with the specific test files via `npx tsx`. **Postgres gotcha:** never compare a numeric column to `''` or `CAST` it — Postgres throws; this plan adds no such SQL.

---

## File Structure

**Backend — new:**
- `backend/src/import/receiptOrderAnchor.ts` — `supersedeAcceptedOrderLinks`, `linkOrderToTransaction`, `anchorReceiptOrderToTransaction`.
- `backend/test/receiptOrderAnchor.test.ts` — integration tests.

**Backend — modified:**
- `backend/src/routes/receipts.ts` — analyze route wires the orchestrator + returns `itemCount`.

**Frontend — new:**
- `frontend/src/lib/useAttachAndAnalyzeReceipt.ts` — shared attach+analyze hook.

**Frontend — modified:**
- `frontend/src/pages/TransactionsPage.tsx` — `capture` attr + use the hook (attach now auto-analyzes).
- `frontend/src/pages/ReviewInboxPage.tsx` — "📷 Add receipt" affordance on item-less rows + `capture` + use the hook.
- `frontend/src/pages/ReviewInboxPage.test.tsx` — new tests.

---

## Task 1: Link helpers — supersede + direct link

**Files:**
- Create: `backend/src/import/receiptOrderAnchor.ts`
- Test: `backend/test/receiptOrderAnchor.test.ts`

Verified facts: `TransactionOrderLink` has `transactionId`, `externalOrderId`, `status` ('suggested'|'accepted'|'rejected'), `confidence` (string), `matchReason` (string). Associations per SP1.

- [ ] **Step 1: Write the failing test**

```ts
// backend/test/receiptOrderAnchor.test.ts
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize, Account, ExternalOrder, TransactionOrderLink, Transaction } from '../src/models';
import { supersedeAcceptedOrderLinks, linkOrderToTransaction } from '../src/import/receiptOrderAnchor';

const HH = 1;
let accountId: number;
let fp = 0;

before(async () => {
  await sequelize.sync({ force: true });
  const acct = await Account.create({ householdId: HH, name: 'Card', visibility: 'private' } as never);
  accountId = acct.id;
});

async function txn(): Promise<number> {
  fp += 1;
  const t = await Transaction.create({
    accountId, householdId: HH, importBatch: 'test', date: '2026-05-01', amount: '-10.00',
    currency: 'CAD', merchantRaw: 'M', merchantClean: 'M', sourceRowFingerprint: `f${fp}`,
    sourceIdentityFingerprint: `f${fp}`, txnType: 'purchase', reviewFlag: true, finalSplitType: 'me',
  } as never);
  return t.id;
}
async function order(): Promise<number> {
  fp += 1;
  const o = await ExternalOrder.create({
    householdId: HH, vendor: 'other', dedupeKey: `dk${fp}`, total: '10.00', currency: 'CAD',
    orderDate: '2026-05-01', source: 'receipt-analyze',
  } as never);
  return o.id;
}

test('linkOrderToTransaction creates an accepted link, idempotent', async () => {
  const t = await txn(); const o = await order();
  await linkOrderToTransaction(o, t);
  await linkOrderToTransaction(o, t); // second call must not create a duplicate
  const links = await TransactionOrderLink.findAll({ where: { transactionId: t, externalOrderId: o } });
  assert.equal(links.length, 1);
  assert.equal((links[0] as unknown as { status: string }).status, 'accepted');
});

test('linkOrderToTransaction promotes an existing suggested link to accepted', async () => {
  const t = await txn(); const o = await order();
  await TransactionOrderLink.create({ transactionId: t, externalOrderId: o, status: 'suggested', confidence: '50', matchReason: 'fuzzy' } as never);
  await linkOrderToTransaction(o, t);
  const link = await TransactionOrderLink.findOne({ where: { transactionId: t, externalOrderId: o } });
  assert.equal((link as unknown as { status: string }).status, 'accepted');
});

test('supersedeAcceptedOrderLinks rejects other accepted links but keeps the kept order', async () => {
  const t = await txn(); const oldO = await order(); const keep = await order();
  await TransactionOrderLink.create({ transactionId: t, externalOrderId: oldO, status: 'accepted', confidence: '90', matchReason: 'amazon' } as never);
  await TransactionOrderLink.create({ transactionId: t, externalOrderId: keep, status: 'accepted', confidence: '100', matchReason: 'receipt-attach' } as never);
  await supersedeAcceptedOrderLinks(t, keep);
  const oldLink = await TransactionOrderLink.findOne({ where: { transactionId: t, externalOrderId: oldO } });
  const keepLink = await TransactionOrderLink.findOne({ where: { transactionId: t, externalOrderId: keep } });
  assert.equal((oldLink as unknown as { status: string }).status, 'rejected');
  assert.equal((keepLink as unknown as { status: string }).status, 'accepted');
});
```

- [ ] **Step 2: Run, verify FAIL (module not found)**

`cd backend && npx tsx --import ./test/setup.ts --test test/receiptOrderAnchor.test.ts`

- [ ] **Step 3: Implement the helpers**

```ts
// backend/src/import/receiptOrderAnchor.ts
import { Op } from 'sequelize';
import { TransactionOrderLink } from '../models';

/** Set every OTHER accepted link on this transaction to 'rejected' (photo wins).
 *  The kept order's link is untouched; rejected order rows are preserved. */
export async function supersedeAcceptedOrderLinks(
  transactionId: number,
  keepOrderId: number,
): Promise<void> {
  await TransactionOrderLink.update(
    { status: 'rejected' },
    { where: { transactionId, status: 'accepted', externalOrderId: { [Op.ne]: keepOrderId } } },
  );
}

/** Create (or promote) an accepted link from a transaction to an order. Idempotent. */
export async function linkOrderToTransaction(
  orderId: number,
  transactionId: number,
): Promise<void> {
  const [link] = await TransactionOrderLink.findOrCreate({
    where: { transactionId, externalOrderId: orderId },
    defaults: {
      transactionId,
      externalOrderId: orderId,
      status: 'accepted',
      confidence: '100',
      matchReason: 'receipt-attach',
    } as never,
  });
  if ((link as unknown as { status: string }).status !== 'accepted') {
    await link.update({ status: 'accepted' });
  }
}
```

- [ ] **Step 4: Run, verify PASS (3 tests)**

`cd backend && npx tsx --import ./test/setup.ts --test test/receiptOrderAnchor.test.ts`

- [ ] **Step 5: Commit**

```bash
git add backend/src/import/receiptOrderAnchor.ts backend/test/receiptOrderAnchor.test.ts
git commit --no-verify -m "feat(receipts): supersede + direct-link helpers for receipt-anchored orders"
```

---

## Task 2: Orchestrator — anchor + categorize + recompute

**Files:**
- Modify: `backend/src/import/receiptOrderAnchor.ts` (add `anchorReceiptOrderToTransaction`)
- Test: append to `backend/test/receiptOrderAnchor.test.ts`

Verified facts:
- `categorizeAndApplyReceiptItems(args: { householdId: number | null; orderId?: number; orderIds?: number[]; limit?: number }, opts?: { openaiCaller?: ReceiptOpenAiCaller }): Promise<number>` (`backend/src/import/categorizeReceiptItems.ts`). It writes `inferred_category` + `confidence` on items AND already calls `recomputeTransactionsReviewFromItems` for the order's accepted-linked txns (SP1 household-wide fix).
- `ReceiptOpenAiCaller` is the injectable AI seam type exported from `categorizeReceiptItems.ts` — import it for the test's fake.
- `ExternalOrderItem` belongs to order via `external_order_id`.
- `recomputeTransactionsReviewFromItems` / `transactionIdsForOrder` from `backend/src/import/enrichment/recomputeTransactionReviewFromItems.ts`.

- [ ] **Step 1: Write the failing test (append)**

```ts
import { ExternalOrderItem, TransactionSignal } from '../src/models';
import { anchorReceiptOrderToTransaction } from '../src/import/receiptOrderAnchor';
import type { ChatMessage } from '../src/import/enrichment/aiBatchStage';

// Fake categorizer caller: returns a high-confidence category for every item key.
// (Match the JSON shape categorizeReceiptItemsWithAi expects — inspect that fn
//  to mirror its response contract; it maps itemId -> {category, confidence}.)
function fakeCategorizer(highConf: boolean) {
  return async (_msgs: ChatMessage[]): Promise<Record<string, unknown>> => {
    // Return a result the categorizer parser turns into per-item suggestions.
    // Shape is determined by categorizeReceiptItemsWithAi — replicate it here.
    return { results: [] }; // placeholder — implementer fills with the real shape
  };
}

async function itemizedOrderLinkedTo(transactionId: number, items: Array<{ inferredCategory: string|null; confidence: number|null }>): Promise<number> {
  // create ExternalOrder + items (inferredCategory/confidence as given) + accepted link
  // ... (reuse helpers from Task 1's test scaffolding)
  return 0;
}

test('anchor: statement txn with high-confidence items clears review', async () => {
  // 1. make a txn (reviewFlag true) with an item-link medium signal
  // 2. create an order with items inferredCategory='Groceries' confidence=90, accepted-linked to the txn
  // 3. call anchorReceiptOrderToTransaction({ orderId, transactionId, householdId: HH }, { openaiCaller: fakeCategorizer(true) })
  // 4. assert reviewFlag === false and the returned itemCount > 0
});

test('anchor: supersedes a prior accepted (amazon) link', async () => {
  // txn with an accepted amazon order link; call anchor with a NEW photo order id
  // assert the amazon link is rejected, the photo link accepted
});

test('anchor: zero-item order leaves txn in review and returns itemCount 0', async () => {
  // order with no items; anchor; assert reviewFlag stays true, itemCount === 0
});
```

> The fake categorizer's return shape MUST match what `categorizeReceiptItemsWithAi` parses. Read that function first and mirror its contract. If wiring the fake through `categorizeAndApplyReceiptItems` is awkward, instead pre-set the items' `inferredCategory`+`confidence` directly in the test and pass an `openaiCaller` that returns an empty result (the categorizer no-ops when there are no null-category items to categorize), then assert anchor's supersede+link+recompute behavior. The REQUIRED assertions are: supersede works, link is accepted, recompute fires (reviewFlag reflects item state), itemCount is returned.

- [ ] **Step 2: Run, verify FAIL**

`cd backend && npx tsx --import ./test/setup.ts --test test/receiptOrderAnchor.test.ts`

- [ ] **Step 3: Implement the orchestrator**

```ts
// add to backend/src/import/receiptOrderAnchor.ts
import { ExternalOrderItem } from '../models';
import { categorizeAndApplyReceiptItems, type ReceiptOpenAiCaller } from './categorizeReceiptItems';
import {
  recomputeTransactionsReviewFromItems,
  transactionIdsForOrder,
} from './enrichment/recomputeTransactionReviewFromItems';

/**
 * Anchor a freshly-extracted receipt order to the transaction the receipt was
 * attached to: the photo order becomes the single accepted order on that txn,
 * its items are categorized (so they gain a confidence), and review is
 * recomputed (SP1). Returns the order's item count.
 */
export async function anchorReceiptOrderToTransaction(
  args: { orderId: number; transactionId: number; householdId: number },
  opts?: { openaiCaller?: ReceiptOpenAiCaller },
): Promise<{ itemCount: number }> {
  await supersedeAcceptedOrderLinks(args.transactionId, args.orderId);
  await linkOrderToTransaction(args.orderId, args.transactionId);
  // Categorize gives items a confidence; this also recomputes review for the
  // order's accepted-linked txns. Best-effort (never throws).
  await categorizeAndApplyReceiptItems({ householdId: args.householdId, orderId: args.orderId }, opts);
  // Safety-net recompute (idempotent) in case categorization no-op'd.
  await recomputeTransactionsReviewFromItems(await transactionIdsForOrder(args.orderId));
  const itemCount = await ExternalOrderItem.count({ where: { externalOrderId: args.orderId } });
  return { itemCount };
}
```

- [ ] **Step 4: Run, verify PASS**

`cd backend && npx tsx --import ./test/setup.ts --test test/receiptOrderAnchor.test.ts`

- [ ] **Step 5: typecheck + commit**

```bash
cd backend && npx tsc --noEmit 2>&1 | grep -E "receiptOrderAnchor" | head; echo done
git add backend/src/import/receiptOrderAnchor.ts backend/test/receiptOrderAnchor.test.ts
git commit --no-verify -m "feat(receipts): anchorReceiptOrderToTransaction orchestrator (supersede+link+categorize+recompute)"
```

---

## Task 3: Wire the orchestrator into the analyze route

**Files:**
- Modify: `backend/src/routes/receipts.ts` (the `POST /receipts/:id/analyze` handler, ~lines 411-441)
- Test: append a route test to `backend/test/receiptOrderAnchor.test.ts` OR add to an existing receipts route test (see note).

Current handler (after `persistExtractedOrder`) calls `matchReceiptOrderToTransactions` + `recomputeTransactionsReviewFromItems`. This route ALWAYS has a valid `row.transactionId` (it 404s earlier if the parent transaction isn't found), so we anchor directly and drop the fuzzy call here.

- [ ] **Step 1: Modify the handler**

Replace the block that currently reads:

```ts
      if (auth.household.id != null) {
        await matchReceiptOrderToTransactions({
          externalOrderId: order.id,
          householdId: auth.household.id,
        });
        await recomputeTransactionsReviewFromItems(await transactionIdsForOrder(order.id));
        if ((EXPANSION_VENDORS as readonly string[]).includes(order.vendor)) {
          await maybeExpandItemNamesForOrder({ householdId: auth.household.id, orderId: order.id });
        }
      }
      res.json({ receipt: row.toJSON(), order: order.toJSON(), extracted });
```

with:

```ts
      let itemCount = 0;
      if (auth.household.id != null) {
        // The receipt is attached to row.transactionId; anchor the extracted
        // order directly to it (photo is authoritative), categorize, recompute.
        const anchored = await anchorReceiptOrderToTransaction({
          orderId: order.id,
          transactionId: row.transactionId,
          householdId: auth.household.id,
        });
        itemCount = anchored.itemCount;
        if ((EXPANSION_VENDORS as readonly string[]).includes(order.vendor)) {
          await maybeExpandItemNamesForOrder({ householdId: auth.household.id, orderId: order.id });
        }
      }
      res.json({ receipt: row.toJSON(), order: order.toJSON(), extracted, itemCount });
```

Add the import at the top of `receipts.ts`:
```ts
import { anchorReceiptOrderToTransaction } from '../import/receiptOrderAnchor';
```
Remove now-unused imports IF nothing else in the file uses them (`matchReceiptOrderToTransactions`, and possibly `recomputeTransactionsReviewFromItems`/`transactionIdsForOrder` — check; the PATCH/analyze recompute wiring from SP1 may still use them elsewhere in this file, so only remove if truly unused).

- [ ] **Step 2: Route test (best-effort)**

If a receipts route test harness with auth exists (search `backend/test` for a receipts route test using supertest + session, like the SP1 pattern), add a test: seed a txn + receipt (image mime) with a stored object, mock `extractReceiptFromImage` to return a small order, POST `/api/receipts/:id/analyze`, assert response has `itemCount` and the txn got an accepted link. **If mocking `extractReceiptFromImage` (no injectable seam) is impractical**, SKIP the full-route test — Task 2 already covers the orchestrator with real DB. In that case, just verify the route compiles and the handler shape is correct, and note the substitution. Do NOT add a network-dependent test.

- [ ] **Step 3: typecheck + targeted tests**

```bash
cd backend && npx tsc --noEmit 2>&1 | grep -E "receipts.ts|receiptOrderAnchor" | head; echo done
cd backend && npx tsx --import ./test/setup.ts --test test/receiptOrderAnchor.test.ts 2>&1 | grep -E "^# (tests|pass|fail)"
```

- [ ] **Step 4: Commit**

```bash
git add backend/src/routes/receipts.ts backend/test/receiptOrderAnchor.test.ts
git commit --no-verify -m "feat(receipts): analyze anchors order to its own transaction + categorizes + returns itemCount"
```

---

## Task 4: Shared frontend attach+analyze hook

**Files:**
- Create: `frontend/src/lib/useAttachAndAnalyzeReceipt.ts`

Existing primitives (from TransactionsPage): `postFormData<{ id: number }>('/api/transactions/:tid/receipts', fd)` then `postJson('/api/receipts/:id/analyze', {})`. The analyze response now includes `itemCount`.

- [ ] **Step 1: Implement the hook**

```ts
// frontend/src/lib/useAttachAndAnalyzeReceipt.ts
import { useCallback, useState } from 'react'
import { postFormData, postJson } from './api'

type AnalyzeResult = { itemCount: number }

export function useAttachAndAnalyzeReceipt(onDone?: () => void | Promise<void>) {
  const [busyTxnId, setBusyTxnId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lastItemCount, setLastItemCount] = useState<number | null>(null)

  const attachAndAnalyze = useCallback(async (file: File, txnId: number) => {
    setBusyTxnId(txnId)
    setError(null)
    setLastItemCount(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const { id } = await postFormData<{ id: number }>(`/api/transactions/${txnId}/receipts`, fd)
      const res = await postJson<AnalyzeResult>(`/api/receipts/${id}/analyze`, {})
      setLastItemCount(res.itemCount ?? 0)
      await onDone?.()
      return res
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Receipt attach/analyze failed')
      return null
    } finally {
      setBusyTxnId(null)
    }
  }, [onDone])

  return { attachAndAnalyze, busyTxnId, error, lastItemCount }
}
```

- [ ] **Step 2: typecheck + commit**

```bash
cd frontend && npx tsc --noEmit 2>&1 | grep -E "useAttachAndAnalyzeReceipt" | head; echo done
git add frontend/src/lib/useAttachAndAnalyzeReceipt.ts
git commit --no-verify -m "feat(frontend): shared useAttachAndAnalyzeReceipt hook"
```

---

## Task 5: TransactionsPage — camera capture + use the hook

**Files:**
- Modify: `frontend/src/pages/TransactionsPage.tsx`

- [ ] **Step 1: Add `capture` to the receipt input**

At the file input (~line 1085-1090), add `capture="environment"`:
```tsx
        type="file"
        accept="image/jpeg,image/png,image/webp"
        capture="environment"
```

- [ ] **Step 2: Route attach through the hook (now auto-analyzes)**

Replace `onReceiptPicked`'s body so that after upload it also analyzes, via the shared hook. Wire the hook near the component top:
```tsx
import { useAttachAndAnalyzeReceipt } from '../lib/useAttachAndAnalyzeReceipt'
// inside component:
const { attachAndAnalyze, error: attachErr } = useAttachAndAnalyzeReceipt(async () => {
  notifyReceiptsChanged()
  await load()
})
```
Rewrite `onReceiptPicked`:
```tsx
  async function onReceiptPicked(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    const tid = attachForTxnId
    setAttachForTxnId(null)
    e.target.value = ''
    if (!file || tid == null) return
    setErr(null)
    await attachAndAnalyze(file, tid)
  }
```
Surface `attachErr` where `err` is shown (or merge). Keep the existing drawer "Extract items" button working for receipts attached without analysis.

- [ ] **Step 3: typecheck + lint + commit**

```bash
cd frontend && npx tsc --noEmit
cd frontend && npx eslint src/pages/TransactionsPage.tsx src/lib/useAttachAndAnalyzeReceipt.ts 2>&1 | tail -5; echo done
git add frontend/src/pages/TransactionsPage.tsx
git commit --no-verify -m "feat(frontend): TransactionsPage camera capture + auto-analyze on attach"
```

---

## Task 6: ReviewInboxPage — "Add receipt" entry point

**Files:**
- Modify: `frontend/src/pages/ReviewInboxPage.tsx`
- Test: `frontend/src/pages/ReviewInboxPage.test.tsx`

- [ ] **Step 1: Write failing tests**

In `ReviewInboxPage.test.tsx` (reuse the `mockInbox` + `vi.mock('@/lib/api')` pattern):
- A review row with `itemized: null` renders an "Add receipt" control (camera/file input).
- Picking a file calls `postFormData('/api/transactions/:id/receipts', ...)` then `postJson('/api/receipts/:id/analyze', ...)` (mock both), then re-runs the inbox load (`getJson('/api/transactions?...')` called again).
- When analyze resolves with `{ itemCount: 0 }`, a "Couldn't read items" message shows.

`cd frontend && npx vitest run src/pages/ReviewInboxPage.test.tsx`

- [ ] **Step 2: Implement**

- Add a hidden `<input type="file" accept="image/jpeg,image/png,image/webp" capture="environment">` plus an "📷 Add receipt" button on rows where `row.itemized == null` (itemized rows already have the badge/expand from SP1).
- Wire `const { attachAndAnalyze, busyTxnId, lastItemCount, error } = useAttachAndAnalyzeReceipt(async () => { await load() })` where `load()` is the inbox's existing reload (the `getJson<Paginated<Transaction>>('/api/transactions?...')` call).
- On click → set the target txn id, open the picker; on file change → `await attachAndAnalyze(file, txnId)`.
- While `busyTxnId === row.id`, show an inline "Analyzing…" state on that row.
- After completion `load()` runs (from the hook's `onDone`): a cleared row drops out; a straggler row shows SP1's badge.
- If `lastItemCount === 0` for the just-analyzed row, show "Couldn't read items — try another photo." inline.

Follow the project's Tailwind conventions (literal class strings; lookup tables for variant classes).

- [ ] **Step 3: Run tests + typecheck + lint**

```bash
cd frontend && npx vitest run src/pages/ReviewInboxPage.test.tsx
cd frontend && npx tsc --noEmit
cd frontend && npx eslint src/pages/ReviewInboxPage.tsx 2>&1 | tail -5; echo done
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/ReviewInboxPage.tsx frontend/src/pages/ReviewInboxPage.test.tsx
git commit --no-verify -m "feat(review): Add-receipt entry point with camera capture in the review inbox"
```

---

## Task 7: Full verification

- [ ] **Step 1: Backend — orchestrator + SP1 tests + tsc**

```bash
cd backend && npx tsx --import ./test/setup.ts --test test/receiptOrderAnchor.test.ts test/recomputeTransactionReviewFromItems.test.ts test/transactionsItemizedSummary.test.ts 2>&1 | grep -E "^# (tests|pass|fail)"
cd backend && npx tsc --noEmit; echo "backend tsc exit $?"
```
Expected: all pass; tsc exit 0.

- [ ] **Step 2: Frontend — full vitest + tsc + lint**

```bash
cd frontend && npx vitest run 2>&1 | grep -E "Test Files|Tests "
cd frontend && npx tsc --noEmit; echo "frontend tsc exit $?"
cd frontend && npx eslint src/pages/ReviewInboxPage.tsx src/pages/TransactionsPage.tsx src/lib/useAttachAndAnalyzeReceipt.ts 2>&1 | tail -5; echo done
```
Expected: all pass; tsc exit 0; lint clean.

- [ ] **Step 3: Manual smoke (optional, needs OpenAI key + a receipt image)**

Attach a photo to a plain statement transaction from the review inbox → confirm it itemizes, categorizes, and either drops from the queue (all high-confidence) or shows the straggler badge. Re-attach a different photo → confirm the prior order is superseded (single accepted order). Attach a blurry/non-receipt image → "couldn't read items".

---

## Self-Review notes (author)

- **Spec coverage:** Gap A (categorize pass) → Task 2/3 via `categorizeAndApplyReceiptItems`. Gap B (link own txn) → Task 1/2/3. Photo-authoritative supersede → Task 1 `supersedeAcceptedOrderLinks`. Camera capture → Tasks 5/6 `capture="environment"`. Inbox entry point → Task 6. Shared hook (DRY) → Task 4, used by 5 & 6. `itemCount` / zero-items UX → Tasks 3 & 6. Email-receipt fuzzy fallback: N/A in this route (analyze requires a transaction; documented in Task 3).
- **Type consistency:** `anchorReceiptOrderToTransaction({orderId, transactionId, householdId}, {openaiCaller})` defined Task 2, called Task 3. `useAttachAndAnalyzeReceipt(onDone)` returning `{ attachAndAnalyze, busyTxnId, error, lastItemCount }` defined Task 4, consumed Tasks 5 & 6. `itemCount` added to analyze response (Task 3) and read by the hook (Task 4).
- **Flagged adaptation points:** the fake-categorizer response shape in Task 2 (mirror `categorizeReceiptItemsWithAi`'s contract, or pre-set item categories + empty caller); the route test feasibility in Task 3 (extraction has no injectable seam — skip full-route test if mocking is impractical, orchestrator is covered).
