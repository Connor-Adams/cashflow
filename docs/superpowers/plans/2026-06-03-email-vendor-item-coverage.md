# Email-Vendor Item Coverage Implementation Plan (SP2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Apple/Google/Uber email-receipt items (Gmail scan, email-paste, image-upload) get a confidence and clear review via the SP1 mechanic when their order strongly matches a transaction — matching the already-complete PDF path.

**Architecture:** Four small wiring changes against the PDF-path pattern: broaden the categorizer to fill confidence on already-categorized items, add the categorize call to the Gmail scan, add the match call to the paste/image routes, and add uber/uber_eats vendor fidelity to extraction. No new files or primitives. Recompute already lives inside `match` and `categorize`.

**Tech Stack:** TypeScript, Node `node:test` via `tsx`, Sequelize, Express.

**Spec:** `docs/superpowers/specs/2026-06-03-email-vendor-item-coverage-design.md`. Depends on SP1 (#541).

**Worktree env:** pre-commit hook broken (`tsx`/`sequelize-cli`/`lint-staged` not on PATH, exit 127) → commit `--no-verify`; run tests via `npx tsx --import ./test/setup.ts --test test/<file>.test.ts` (NOT `yarn test`). Postgres: never compare a numeric column to `''` (this plan adds no such SQL; `{ confidence: null }` is a Sequelize NULL match, which is fine).

---

## Task 1: Vendor fidelity — uber / uber_eats in extraction

**Files:**
- Modify: `backend/src/ai/extractReceiptItems.ts` (prompt schema line ~67, `parseVendor` lines 112-115)
- Test: `backend/test/parseVendorUber.test.ts` (new)

`parseVendor` currently:
```ts
function parseVendor(v: unknown): ExtractedReceiptOrder['vendor'] {
  if (v === 'amazon' || v === 'apple' || v === 'google' || v === 'costco') return v;
  return 'other';
}
```
The `ExtractedReceiptOrder['vendor']` type already includes `'uber' | 'uber_eats'` (line 44). The prompt schema (line ~67) lists only `"amazon" | "apple" | "google" | "other"`.

- [ ] **Step 1: Write the failing test**

```ts
// backend/test/parseVendorUber.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractReceiptFromText } from '../src/ai/extractReceiptItems';

// parseVendor is not exported; test it through extractReceiptFromText with an
// injected caller IF that's supported, otherwise export parseVendor for testing.
// Simplest: export parseVendor and test it directly.
import { parseVendor } from '../src/ai/extractReceiptItems';

test('parseVendor accepts uber and uber_eats', () => {
  assert.equal(parseVendor('uber'), 'uber');
  assert.equal(parseVendor('uber_eats'), 'uber_eats');
});
test('parseVendor keeps existing vendors and falls back to other', () => {
  assert.equal(parseVendor('apple'), 'apple');
  assert.equal(parseVendor('costco'), 'costco');
  assert.equal(parseVendor('nonsense'), 'other');
});
```

- [ ] **Step 2: Run, verify FAIL**

`cd backend && npx tsx --import ./test/setup.ts --test test/parseVendorUber.test.ts`
Expected: FAIL — `parseVendor` not exported, and/or `'uber'` returns `'other'`.

- [ ] **Step 3: Implement**

Add `export` to `parseVendor` and extend the allowlist:
```ts
export function parseVendor(v: unknown): ExtractedReceiptOrder['vendor'] {
  if (
    v === 'amazon' || v === 'apple' || v === 'google' ||
    v === 'costco' || v === 'uber' || v === 'uber_eats'
  ) return v;
  return 'other';
}
```
And update the prompt schema (line ~67) to list the vendors the model may emit:
```
  "vendor": "amazon" | "apple" | "google" | "uber" | "uber_eats" | "other",
```
(Leave `costco` out of the prompt if it wasn't there — SP2 scope is apple/google/uber; only ADD uber/uber_eats to the prompt. Do not remove anything.)

- [ ] **Step 4: Run, verify PASS (2 tests)**

`cd backend && npx tsx --import ./test/setup.ts --test test/parseVendorUber.test.ts`

- [ ] **Step 5: Commit**

```bash
git add backend/src/ai/extractReceiptItems.ts backend/test/parseVendorUber.test.ts
git commit --no-verify -m "feat(receipts): extraction vendor fidelity for uber / uber_eats"
```

---

## Task 2: Broaden the categorizer to fill confidence

**Files:**
- Modify: `backend/src/import/categorizeReceiptItems.ts` (line 114: `itemWhere`)
- Test: `backend/test/categorizeReceiptItemsConfidence.test.ts` (new)

Line 114 currently: `const itemWhere: Record<string, unknown> = { inferredCategory: null }`.

- [ ] **Step 1: Write the failing test**

The change makes the categorizer process items that have a category but `confidence = null`. Inject the AI caller (the `opts.openaiCaller` seam) so no network is hit. First READ `categorizeReceiptItemsWithAi` to mirror the caller's expected request/response contract (it maps item → {category, confidence}); construct a fake caller that returns a high confidence for the seeded item.

```ts
// backend/test/categorizeReceiptItemsConfidence.test.ts
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize, ExternalOrder, ExternalOrderItem } from '../src/models';
import { categorizeAndApplyReceiptItems } from '../src/import/categorizeReceiptItems';
import type { ReceiptOpenAiCaller } from '../src/import/categorizeReceiptItems';

const HH = 1;
before(async () => { await sequelize.sync({ force: true }); });

// Fake caller returning a category + high confidence for every item.
// MIRROR the real response contract of categorizeReceiptItemsWithAi (read it first).
const caller: ReceiptOpenAiCaller = async (/* messages, options */) => {
  // return shape the parser turns into per-item { category, confidence } suggestions
  return /* ... */ ({} as never);
};

async function order(vendor: string): Promise<number> {
  const o = await ExternalOrder.create({ householdId: HH, vendor, dedupeKey: `dk-${vendor}-${Date.now()}`, total: '10.00', currency: 'CAD', orderDate: '2026-05-01', source: 'test' } as never);
  return o.id;
}

test('categorizer now fills confidence on a category-but-null-confidence item', async () => {
  const o = await order('uber');
  const item = await ExternalOrderItem.create({ externalOrderId: o, title: 'Uber trip', inferredCategory: 'Transport', categoryOverride: null, confidence: null } as never);
  await categorizeAndApplyReceiptItems({ householdId: HH, orderId: o }, { openaiCaller: caller });
  const after = await ExternalOrderItem.findByPk(item.id);
  assert.notEqual((after as unknown as { confidence: string | null }).confidence, null);
});

test('categorizer does NOT re-process an item that already has a confidence', async () => {
  const o = await order('uber');
  const item = await ExternalOrderItem.create({ externalOrderId: o, title: 'Uber trip', inferredCategory: 'Transport', categoryOverride: null, confidence: '88' } as never);
  await categorizeAndApplyReceiptItems({ householdId: HH, orderId: o }, { openaiCaller: caller });
  const after = await ExternalOrderItem.findByPk(item.id);
  assert.equal((after as unknown as { confidence: string }).confidence, '88'); // unchanged
});
```

> If mirroring the caller's response contract proves fiddly, instead assert the SELECTION change directly: spy/capture what items the fake caller is asked about (the caller receives the item titles in its messages), and assert the category+null-confidence item IS included after the change and was NOT before. The REQUIRED assertion: an item with a category but null confidence is now picked up by the categorizer (and one with a confidence is not).

- [ ] **Step 2: Run, verify FAIL** (item's confidence stays null because the old filter skipped it)

`cd backend && npx tsx --import ./test/setup.ts --test test/categorizeReceiptItemsConfidence.test.ts`

- [ ] **Step 3: Implement**

Change line 114 from:
```ts
  const itemWhere: Record<string, unknown> = { inferredCategory: null }
```
to:
```ts
  // Process any item lacking a confidence (including deterministically-parsed
  // Apple/Google/Uber items that already have a category but no confidence), so
  // they can satisfy the SP1 review-clear bar.
  const itemWhere: Record<string, unknown> = { confidence: null }
```
Read the surrounding function to confirm nothing else depends on `inferredCategory: null` (e.g. prompt construction assuming null categories). The prompt categorizes whatever items it's given; a non-null prior category is acceptable input.

- [ ] **Step 4: Run, verify PASS (2 tests)**

- [ ] **Step 5: typecheck + commit**

```bash
cd backend && npx tsc --noEmit 2>&1 | grep -E "categorizeReceiptItems" | head; echo done
git add backend/src/import/categorizeReceiptItems.ts backend/test/categorizeReceiptItemsConfidence.test.ts
git commit --no-verify -m "feat(receipts): categorizer fills confidence on category-but-null-confidence items"
```

---

## Task 3: Wire categorize into the Gmail scan

**Files:**
- Modify: `backend/src/integrations/scanReceipts.ts` (after the `matchReceiptOrderToTransactions` call for a newly created order, ~lines 563-572)

- [ ] **Step 1: Read the call site**

Find where `scanInbox` calls `matchReceiptOrderToTransactions(...)` for a newly created order (~line 565). Confirm the `householdId` and `order.id` variables in scope.

- [ ] **Step 2: Add the categorize call**

Add the import (if not present):
```ts
import { categorizeAndApplyReceiptItems } from '../import/categorizeReceiptItems';
```
Immediately AFTER the `matchReceiptOrderToTransactions(...)` call for the created order, add (best-effort — the function never throws):
```ts
await categorizeAndApplyReceiptItems({ householdId, orderId: order.id });
```
Match the surrounding async/await + error-handling style (the match call is fire-and-forget per the explorer — keep categorize consistent with it; if match is `void`/not awaited, await categorize after or chain it the same way the file does). Order must be match → categorize so the recompute inside categorize runs last (sees the link + confidence).

- [ ] **Step 3: typecheck**

`cd backend && npx tsc --noEmit 2>&1 | grep -E "scanReceipts" | head; echo done`

- [ ] **Step 4: Commit**

```bash
git add backend/src/integrations/scanReceipts.ts
git commit --no-verify -m "feat(receipts): Gmail scan categorizes items after matching (fills confidence)"
```

> No unit test here — `scanInbox` is a Gmail-integration orchestrator that's impractical to drive in the node:test harness without heavy mocking. The behavior (broadened categorize → confidence → recompute clears) is covered by Tasks 2 and 5. Verify by tsc + the manual smoke in Task 5.

---

## Task 4: Wire match into the email-paste + image-upload routes

**Files:**
- Modify: `backend/src/routes/externalOrders.ts` (the `import-text` handler ~line 314-349 and `import-image` handler ~line 356-394)

Both handlers currently call `categorizeAndApplyReceiptItems` but never `matchReceiptOrderToTransactions`. Add the match call so an accepted link can form and the recompute clears the matched transaction.

- [ ] **Step 1: Read both handlers**

Confirm the `order.id` / `createdOrderIds` and `auth.household.id` variables in scope, and where `categorizeAndApplyReceiptItems` is called in each.

- [ ] **Step 2: Add the match call**

Ensure the import exists:
```ts
import { matchReceiptOrderToTransactions } from '../import/matchReceiptToTransactions';
```
In the `import-text` handler, after the order is persisted (and around the existing categorize call), add for the created order:
```ts
await matchReceiptOrderToTransactions({ externalOrderId: order.id, householdId: auth.household.id });
```
Do the same in the `import-image` handler for its created order. Mirror the PDF path's ordering (match then categorize) for consistency — i.e. place `matchReceiptOrderToTransactions` BEFORE `categorizeAndApplyReceiptItems` so categorize's internal recompute runs last with the link present. If restructuring the existing order is risky, instead place match AFTER categorize (match's own recompute then runs last) — either is correct since both call recompute; pick the lower-churn option and keep it consistent across both handlers. Guard on `auth.household.id != null` consistent with the surrounding code.

- [ ] **Step 3: typecheck**

`cd backend && npx tsc --noEmit 2>&1 | grep -E "externalOrders" | head; echo done`

- [ ] **Step 4: Commit**

```bash
git add backend/src/routes/externalOrders.ts
git commit --no-verify -m "feat(receipts): email-paste + image-upload routes match orders to transactions"
```

---

## Task 5: Integration test (clear via scan/paste) + verification

**Files:**
- Test: `backend/test/emailVendorClears.test.ts` (new)

This proves the end-state: an email-vendor order whose items are high-confidence and that is accepted-linked to a transaction clears review. Drive it at the seam level (DB + the functions), not the Gmail integration.

- [ ] **Step 1: Write the test**

```ts
// backend/test/emailVendorClears.test.ts
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize, Account, Transaction, TransactionSignal, ExternalOrder, ExternalOrderItem } from '../src/models';
import { matchReceiptOrderToTransactions } from '../src/import/matchReceiptToTransactions';
import { categorizeAndApplyReceiptItems } from '../src/import/categorizeReceiptItems';
import type { ReceiptOpenAiCaller } from '../src/import/categorizeReceiptItems';

const HH = 1; let accountId: number; let fp = 0;
before(async () => {
  await sequelize.sync({ force: true });
  accountId = (await Account.create({ householdId: HH, name: 'Card', visibility: 'private' } as never)).id;
});

// caller mirrors categorizeReceiptItemsWithAi's contract; returns high confidence.
const caller: ReceiptOpenAiCaller = async (/* ... */) => ({} as never); // fill from the real contract

test('uber email order: strong txn match + categorize clears review', async () => {
  fp += 1;
  // Transaction that an uber order will match on amount+vendor+date, reviewFlag true with an item-link signal.
  const txn = await Transaction.create({
    accountId, householdId: HH, importBatch: 'test', date: '2026-05-01', amount: '-24.50',
    currency: 'CAD', merchantRaw: 'UBER TRIP HELP.UBER.COM', merchantClean: 'Uber',
    sourceRowFingerprint: `f${fp}`, sourceIdentityFingerprint: `f${fp}`, txnType: 'purchase',
    reviewFlag: true, finalSplitType: 'me',
  } as never);
  await TransactionSignal.create({ transactionId: txn.id, source: 'item-link', confidence: 'medium', fields: { autoCategory: 'Mixed' } } as never);
  const order = await ExternalOrder.create({ householdId: HH, vendor: 'uber', dedupeKey: `dk${fp}`, total: '24.50', currency: 'CAD', orderDate: '2026-05-01', source: 'email-paste' } as never);
  await ExternalOrderItem.create({ externalOrderId: order.id, title: 'Uber trip', inferredCategory: 'Transport', categoryOverride: null, confidence: null } as never);

  await matchReceiptOrderToTransactions({ externalOrderId: order.id, householdId: HH });
  await categorizeAndApplyReceiptItems({ householdId: HH, orderId: order.id }, { openaiCaller: caller });

  assert.equal((await Transaction.findByPk(txn.id))!.reviewFlag, false);
});
```

> Adjust the transaction's amount/date/merchant so `matchReceiptOrderToTransactions` scores ≥85 (amount 50 + vendor 15 + date 25 = 90 → auto-accept). If the match doesn't auto-accept, read `scoreOrderTransactionMatch`/`decideAutoAccept` in `matchReceiptToTransactions.ts` and tune the fixture. The caller must return a high confidence for the item (mirror the categorizer contract, as in Task 2). If the contract is awkward, pre-seed the item with `confidence: '90'` (already passing the bar) and assert that match alone (with categorize as a no-op) clears — that still proves match→accepted-link→recompute, which is the new wiring; note the substitution.

- [ ] **Step 2: Run, verify it passes after Tasks 1-4** (it exercises the wired behavior)

`cd backend && npx tsx --import ./test/setup.ts --test test/emailVendorClears.test.ts`

- [ ] **Step 3: Commit**

```bash
git add backend/test/emailVendorClears.test.ts
git commit --no-verify -m "test(receipts): email-vendor order clears review via match + categorize"
```

- [ ] **Step 4: Full verification**

```bash
cd backend && npx tsx --import ./test/setup.ts --test test/parseVendorUber.test.ts test/categorizeReceiptItemsConfidence.test.ts test/emailVendorClears.test.ts test/receiptOrderAnchor.test.ts test/recomputeTransactionReviewFromItems.test.ts 2>&1 | grep -E "^# (tests|pass|fail)"
cd backend && npx tsc --noEmit; echo "backend tsc exit $?"
```
Expected: all pass; tsc exit 0.

- [ ] **Step 5: Manual smoke (optional, needs OpenAI key + Gmail)**

Scan/paste an Apple, Google, and Uber email receipt that matches a real transaction → confirm items get a confidence and the transaction drops from review (strong match) or shows the SP1 straggler badge.

---

## Self-Review notes (author)

- **Spec coverage:** Gap 1 (scan categorize) → Task 3; Gap 2 (broaden filter) → Task 2; Gap 3 (paste/image match) → Task 4; Gap 4 (no policy change) → untouched; Gap 5 (uber/uber_eats fidelity) → Task 1. End-to-end clear → Task 5.
- **Type consistency:** `ReceiptOpenAiCaller` (Tasks 2 & 5) is imported from `categorizeReceiptItems.ts`; `parseVendor` exported in Task 1. `categorizeAndApplyReceiptItems`/`matchReceiptOrderToTransactions` signatures match SP1/SP3 usage.
- **Flagged adaptation points:** the fake categorizer response contract (Tasks 2 & 5 — mirror `categorizeReceiptItemsWithAi`, or pre-seed confidence); the match fixture must score ≥85 (Task 5 — tune amount/vendor/date); scan/route call ordering (await + match-then-categorize). No unit test for the Gmail orchestrator itself (Task 3) — covered by Tasks 2 & 5 + tsc + manual smoke.
