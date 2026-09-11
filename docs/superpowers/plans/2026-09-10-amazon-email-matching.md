# Amazon Email Matching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take Amazon transactions from 0% itemized to ~49% by giving email-sourced orders a date, wiring up the auto-accept that already exists, merging duplicate orders, and excluding orders paid on cards Cashflow does not track.

**Architecture:** Six independent workstreams against existing code. No new tables, no migrations, no new primitives. The load-bearing change is a one-line fallback (`extracted.orderDate ?? dateFromInternalDate(full.internalDate)`) plus a new exact-cent scoring band that routes undated-order matches through `selectMatchCandidates`' existing tie guard. A single `cardOwnership` resolver serves both match disambiguation and foreign-card exclusion.

**Tech Stack:** TypeScript, Express, Sequelize (dual-dialect SQLite/Postgres), React 19 + Vite + Tailwind v4. Backend tests are **colocated** `foo.test.ts` beside `foo.ts`, run under `node:test` via `tsx`. Frontend uses vitest.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-09-10-amazon-email-matching-design.md`. Read it before starting.
- **Zero new tables, zero migrations, zero new primitives.** If a task seems to need one, stop and escalate.
- **Undated orders match on EXACT CENTS ONLY.** At ±$0.50 the null test returns 21–29 false positives against 45 matches. Never loosen this tolerance without re-running the null test.
- **Task 11's tie guard MUST ship in the same commit as Task 11's last4 signal.** Shipping the signal alone pushes exact-cent candidates into the ungated `strong` tier and reintroduces fan-out.
- **Never overwrite a non-null field during reprocess.** A user may have corrected it.
- Run all commands from the **repo root**. Backend single test: `cd backend && yarn tsx --import ./test/setup.ts --test src/path/to/file.test.ts`
- Amounts are `DECIMAL` columns surfaced as strings. Compare with a float epsilon (`< 0.005`), never `=== 0`.
- Commit after every task. Conventional Commits. No `Co-Authored-By` trailers.

---

## File Structure

**Created:**
- `backend/src/amazon/cardOwnership.ts` — last4 resolver + ownership classifier. Pure, no DB.
- `backend/src/amazon/cardOwnership.test.ts`
- `backend/src/amazon/mergeDuplicateOrders.ts` — fold `amazon_report` + email rows sharing a `vendor_order_id`.
- `backend/src/amazon/mergeDuplicateOrders.test.ts`
- `backend/src/jobs/definitions/gmailReceiptScan.ts` — cron job definition.
- `backend/src/integrations/internalDate.ts` — `dateFromInternalDate` helper. Shared by scan and discovery.
- `backend/src/integrations/internalDate.test.ts`

**Modified:**
- `backend/src/integrations/scanReceipts.ts` — internalDate fallback (~:707), parser merge (`parseReceiptText` :168-193), `forceReprocess` (~:472).
- `backend/src/integrations/discoverReceiptSources.ts` — internalDate fallback (:219), subtotal/tax bug (:221-222).
- `backend/src/integrations/parsers/amazon.ts` — `DATE_RE` (:55).
- `backend/src/ai/extractReceiptItems.ts` — `SYSTEM_PROMPT` schema (:63-101).
- `backend/src/amazon/matcher.ts` — exact-cent band (:92-104), `selectMatchCandidates` tie guard (:64-84), account last4 (:25, :125), Prime filter (:199).
- `backend/src/amazon/backfillAutoAcceptLinks.ts` — no change; gains a caller in `matcher.ts`.
- `backend/src/summary/loadItemAllocations.ts` — ownership filter (:33-37).
- `backend/src/routes/items.ts` — ownership filter at :430, :266, :355.
- `backend/src/routes/amazon.ts` — `cardOwnership` in the review DTO (:47 `orderInclude`, :316).
- `shared/api-types.ts` — `ExternalOrderView` (:1144), `ItemRow` (:1277).
- `frontend/src/pages/ItemsPage.tsx`, `frontend/src/components/items/ItemsFilterStrip.tsx` — badges.
- `backend/src/server.ts` — register the new job (after :28).

---

## Group A — Email orders get a date

*Unlocks 30 transactions. This is half of everything; do it first.*

### Task 1: `dateFromInternalDate` helper

**Files:**
- Create: `backend/src/integrations/internalDate.ts`
- Test: `backend/src/integrations/internalDate.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `dateFromInternalDate(internalDate: string | null | undefined): string | null` — converts Gmail's ms-since-epoch string to a `YYYY-MM-DD` UTC date string.

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/integrations/internalDate.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dateFromInternalDate } from './internalDate';

test('converts Gmail internalDate ms-since-epoch to a UTC date string', () => {
  // 2025-08-28T14:32:11Z
  assert.equal(dateFromInternalDate('1756391531000'), '2025-08-28');
});

test('uses UTC, not local time, near a day boundary', () => {
  // 2025-08-28T23:59:59Z — must not roll back a day in a negative-offset TZ
  assert.equal(dateFromInternalDate('1756425599000'), '2025-08-28');
});

test('returns null for null, undefined, empty and non-numeric input', () => {
  assert.equal(dateFromInternalDate(null), null);
  assert.equal(dateFromInternalDate(undefined), null);
  assert.equal(dateFromInternalDate(''), null);
  assert.equal(dateFromInternalDate('not-a-number'), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/integrations/internalDate.test.ts`
Expected: FAIL — `Cannot find module './internalDate'`

- [ ] **Step 3: Write minimal implementation**

```ts
// backend/src/integrations/internalDate.ts
/**
 * Gmail hands every message an `internalDate` (ms since epoch) that we already
 * fetch but have never used. Amazon sends order confirmations within minutes of
 * the order, so the email's own date is a near-exact order date — and unlike the
 * body, it is always present. See
 * docs/superpowers/specs/2026-09-10-amazon-email-matching-design.md.
 */
export function dateFromInternalDate(
  internalDate: string | null | undefined,
): string | null {
  if (internalDate == null || internalDate === '') return null;
  const ms = Number(internalDate);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/integrations/internalDate.test.ts`
Expected: PASS, 3 tests

- [ ] **Step 5: Commit**

```bash
git add backend/src/integrations/internalDate.ts backend/src/integrations/internalDate.test.ts
git commit -m "feat(integrations): add dateFromInternalDate helper"
```

---

### Task 2: Use the fallback in both persist paths

**Files:**
- Modify: `backend/src/integrations/scanReceipts.ts:707`
- Modify: `backend/src/integrations/discoverReceiptSources.ts:219` and `:221-222`
- Test: `backend/src/integrations/scanReceiptsOrderDate.test.ts` (new file — `scanReceipts.test.ts` is already large)

**Interfaces:**
- Consumes: `dateFromInternalDate` from Task 1.
- Produces: `ExternalOrder.orderDate` is non-null for every email-sourced order.

Both call sites already have the fetched message in scope: `full.internalDate` at `scanReceipts.ts:561` and `full` at `discoverReceiptSources.ts:265`.

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/integrations/scanReceiptsOrderDate.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExternalOrder } from '../models';
import { scanInbox } from './scanReceipts';

const ACCESS = { userId: 1, householdId: 1 };

function gmailMessage(internalDate: string) {
  return {
    id: 'msg-1',
    internalDate,
    labelIds: [],
    payload: {
      headers: [
        { name: 'From', value: 'auto-confirm@amazon.ca' },
        { name: 'Subject', value: 'Your Amazon.ca order' },
      ],
      body: {
        data: Buffer.from(
          'Your Amazon.ca order\nOrder # 701-1111111-2222222\n' +
            'Arriving Thursday, September 4\nOrder Total: $44.97\nQuantity: 1\n$44.97\n',
        ).toString('base64url'),
      },
    },
  };
}

test('falls back to the email internalDate when the parser finds no order date', async () => {
  await scanInbox(ACCESS, {}, {
    listMessageIds: async () => [{ id: 'msg-1' }],
    // 2025-08-28T14:32:11Z
    fetchMessage: async () => gmailMessage('1756391531000') as never,
    extractFromText: async () => {
      throw new Error('deterministic parser should have handled this');
    },
  });

  const order = await ExternalOrder.findOne({ where: { vendorOrderId: '701-1111111-2222222' } });
  assert.ok(order, 'order was created');
  assert.equal(order.orderDate, '2025-08-28');
});

test('a parsed order date wins over the email internalDate', async () => {
  const msg = gmailMessage('1756391531000');
  msg.payload.body.data = Buffer.from(
    'Your Amazon.ca order\nOrder # 701-3333333-4444444\n' +
      'Order Placed: July 2, 2025\nOrder Total: $12.00\nQuantity: 1\n$12.00\n',
  ).toString('base64url');

  await scanInbox(ACCESS, {}, {
    listMessageIds: async () => [{ id: 'msg-1' }],
    fetchMessage: async () => msg as never,
    extractFromText: async () => {
      throw new Error('deterministic parser should have handled this');
    },
  });

  const order = await ExternalOrder.findOne({ where: { vendorOrderId: '701-3333333-4444444' } });
  assert.ok(order);
  assert.equal(order.orderDate, '2025-07-02');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/integrations/scanReceiptsOrderDate.test.ts`
Expected: FAIL — first test asserts `'2025-08-28'` but receives `null`

- [ ] **Step 3: Apply the fallback in `scanReceipts.ts`**

Add the import at the top of `backend/src/integrations/scanReceipts.ts`:

```ts
import { dateFromInternalDate } from './internalDate';
```

Change line 707 inside the `ExternalOrder.findOrCreate` `defaults` block from:

```ts
            orderDate: extracted!.orderDate,
```

to:

```ts
            orderDate: extracted!.orderDate ?? dateFromInternalDate(full.internalDate),
```

- [ ] **Step 4: Apply the same fallback in `discoverReceiptSources.ts`**

Add the import at the top:

```ts
import { dateFromInternalDate } from './internalDate';
```

Change line 219 from:

```ts
          orderDate: extracted.orderDate,
```

to:

```ts
          orderDate: extracted.orderDate ?? dateFromInternalDate(full.internalDate),
```

While in this block, fix the hardcoded-null bug at lines 221-222. Change:

```ts
          subtotal: null,
          tax: null,
```

to:

```ts
          subtotal: extracted.subtotal != null ? String(extracted.subtotal) : null,
          tax: extracted.tax != null ? String(extracted.tax) : null,
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/integrations/scanReceiptsOrderDate.test.ts`
Expected: PASS, 2 tests

Then the neighbours, to catch regressions:
Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/integrations/discoverReceiptSources.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add backend/src/integrations/scanReceipts.ts \
        backend/src/integrations/discoverReceiptSources.ts \
        backend/src/integrations/scanReceiptsOrderDate.test.ts
git commit -m "fix(integrations): fall back to email internalDate for order date

Amazon confirmation emails state a delivery date, not an order date, so
both parsers correctly return null and 140 of 141 email-sourced orders
had no order_date at all. Gmail's internalDate was already fetched at
scanReceipts.ts:561 and never used.

Also fixes discoverReceiptSources hardcoding subtotal/tax to null even
though the parser returns both."
```

---

### Task 3: Exact-cent scoring band

**Files:**
- Modify: `backend/src/amazon/matcher.ts:92-104`
- Test: `backend/src/amazon/matcher.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `scoreAmazonOrderMatch` returns `secondaryScore >= 20` when the amount matches to the cent.

An undated exact-cent order scores 65 (50 amount + 15 merchant), which stays **below** `MATCH_CONFIDENCE_THRESHOLD` (70) and therefore routes through `selectMatchCandidates`' fallback tier, where the existing tie guard breaks the tie on `secondaryScore`. Do **not** raise the primary score — that pushes it into the `strong` tier, which returns every candidate and reintroduces fan-out.

- [ ] **Step 1: Write the failing test**

```ts
// append to backend/src/amazon/matcher.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreAmazonOrderMatch, selectMatchCandidates } from './matcher';

const txn = {
  amount: '-44.97',
  date: '2025-08-28',
  merchantRaw: 'AMZN MKTP CA*Z90R91K22',
  merchantClean: 'Amazon',
  notes: null,
  sourceReference: null,
  accountId: 1,
} as never;

const undatedOrder = (total: string) =>
  ({ total, orderDate: null, shipmentDate: null, paymentLast4: null, currency: 'CAD' } as never);

test('an exact-cent amount match credits secondaryScore', () => {
  const exact = scoreAmazonOrderMatch(txn, undatedOrder('44.97'));
  assert.equal(exact.secondaryScore >= 20, true, 'exact cent match scores on secondary');
  assert.match(exact.matchReason, /to the cent/);
});

test('a near-miss inside $0.50 does NOT credit secondaryScore', () => {
  const near = scoreAmazonOrderMatch(txn, undatedOrder('44.70'));
  assert.equal(near.secondaryScore, 0);
});

test('exact-cent and near-miss tie on confidence but the exact one wins', () => {
  const exact = scoreAmazonOrderMatch(txn, undatedOrder('44.97'));
  const near = scoreAmazonOrderMatch(txn, undatedOrder('44.70'));
  assert.equal(exact.confidence, near.confidence, 'both score 65 — this is the tie that used to abstain');

  const picked = selectMatchCandidates([
    { id: 'near', confidence: near.confidence, secondary: near.secondaryScore },
    { id: 'exact', confidence: exact.confidence, secondary: exact.secondaryScore },
  ]);
  assert.equal(picked.length, 1);
  assert.equal((picked[0] as { id: string }).id, 'exact');
});

test('an undated exact-cent order stays below the strong threshold', () => {
  const exact = scoreAmazonOrderMatch(txn, undatedOrder('44.97'));
  assert.equal(exact.confidence < 70, true, 'must stay in the fallback tier — fan-out guard');
});

test('two exact-cent orders abstain rather than fan out', () => {
  const a = scoreAmazonOrderMatch(txn, undatedOrder('44.97'));
  const b = scoreAmazonOrderMatch(txn, undatedOrder('44.97'));
  const picked = selectMatchCandidates([
    { id: 'a', confidence: a.confidence, secondary: a.secondaryScore },
    { id: 'b', confidence: b.confidence, secondary: b.secondaryScore },
  ]);
  assert.equal(picked.length, 0, 'ambiguous — abstain');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/amazon/matcher.test.ts --test-name-pattern 'exact-cent'`
Expected: FAIL — `secondaryScore` is 0 for the exact match

- [ ] **Step 3: Write the implementation**

In `backend/src/amazon/matcher.ts`, replace the amount block (lines 92-104):

```ts
  if (orderTotal != null) {
    const diff = Math.abs(txnAmount - Math.abs(orderTotal));
    if (diff <= 0.5) {
      score += 50;
      reasons.push(`amount within $0.50 (${diff.toFixed(2)})`);
    } else if (diff <= 2) {
      score += 35;
      reasons.push(`amount within $2.00 (${diff.toFixed(2)})`);
    } else {
      score -= 25;
      reasons.push(`total mismatch over $2.00 (${diff.toFixed(2)})`);
    }
  }
```

with:

```ts
  if (orderTotal != null) {
    const diff = Math.abs(txnAmount - Math.abs(orderTotal));
    // Exact-cent is a distinct tier ABOVE ±$0.50, credited to secondaryScore
    // rather than confidence. Against undated orders (which score 65 and land
    // in selectMatchCandidates' fallback tier) an exact-cent match yields 30
    // real links with a null-test of ~0 false positives, while ±$0.50 yields 45
    // with a null-test of 21-29. Raising the primary score instead would push
    // these into the `strong` tier, which returns EVERY candidate — the
    // historical fan-out. Amounts are DECIMAL-as-string, so compare with an
    // epsilon, never `=== 0`.
    if (diff < 0.005) {
      score += 50;
      secondary += 20;
      reasons.push('amount matches to the cent');
    } else if (diff <= 0.5) {
      score += 50;
      reasons.push(`amount within $0.50 (${diff.toFixed(2)})`);
    } else if (diff <= 2) {
      score += 35;
      reasons.push(`amount within $2.00 (${diff.toFixed(2)})`);
    } else {
      score -= 25;
      reasons.push(`total mismatch over $2.00 (${diff.toFixed(2)})`);
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/amazon/matcher.test.ts`
Expected: PASS — all tests, including the pre-existing ones

- [ ] **Step 5: Commit**

```bash
git add backend/src/amazon/matcher.ts backend/src/amazon/matcher.test.ts
git commit -m "feat(amazon): add exact-cent scoring band for undated orders

30 of 60 unmatched Amazon transactions have an order in the corpus with
the correct total but no order_date, so they tie at 65 against near-miss
orders and selectMatchCandidates abstains. Crediting exact-cent matches
to secondaryScore breaks that tie through the existing fallback guard,
without promoting them into the ungated strong tier."
```

---

### Task 4: `DATE_RE` handles day-of-week prefixes and "Ordered on"

**Files:**
- Modify: `backend/src/integrations/parsers/amazon.ts:55`
- Test: `backend/src/integrations/parsers/amazon.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `parseAmazonReceiptEmail` returns a non-null `orderDate` for two more real-world phrasings.

- [ ] **Step 1: Write the failing test**

```ts
// append to backend/src/integrations/parsers/amazon.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAmazonReceiptEmail } from './amazon';

const body = (dateLine: string) =>
  `Your Amazon.ca order\nOrder # 701-1111111-2222222\n${dateLine}\nOrder Total: $44.97\nQuantity: 1\n$44.97\n`;

test('parses a date behind a day-of-week prefix', () => {
  const r = parseAmazonReceiptEmail(body('Arriving Thursday, September 4, 2025'));
  assert.equal(r?.orderDate, '2025-09-04');
});

test('parses the "Ordered on" phrasing', () => {
  const r = parseAmazonReceiptEmail(body('Ordered on August 28, 2025'));
  assert.equal(r?.orderDate, '2025-08-28');
});

test('still parses the phrasings that already worked', () => {
  assert.equal(parseAmazonReceiptEmail(body('Order Placed: July 2, 2025'))?.orderDate, '2025-07-02');
  assert.equal(parseAmazonReceiptEmail(body('Order Date: 2025-07-02'))?.orderDate, '2025-07-02');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/integrations/parsers/amazon.test.ts --test-name-pattern 'day-of-week|Ordered on'`
Expected: FAIL — both return `undefined`/`null`

- [ ] **Step 3: Write the implementation**

In `backend/src/integrations/parsers/amazon.ts`, replace `DATE_RE` (line 55):

```ts
const DATE_RE = /\b(?:Placed\s*on|Order\s*placed|Order\s*Date|Date|Arriving|Shipped\s*on)\b\s*[:\-]?\s*([A-Za-z]{3,9}\s+[0-9]{1,2},?\s+[0-9]{4}|[0-9]{4}-[0-9]{2}-[0-9]{2})/i;
```

with:

```ts
// DATE_RE: matches "Placed on", "Order placed", "Ordered on", "Order Date:",
// standalone "Date:", and ship-confirm phrasings "Arriving <date>" /
// "Shipped on <date>". An optional day-of-week prefix is skipped — Amazon
// routinely writes "Arriving Thursday, September 4, 2025", which the previous
// pattern failed on (it matched "Thursday" as the month, then wanted digits and
// found a comma).
const DAY_OF_WEEK = '(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day,?\\s*';
const DATE_RE = new RegExp(
  `\\b(?:Placed\\s*on|Order\\s*placed|Ordered\\s*on|Order\\s*Date|Date|Arriving|Shipped\\s*on)\\b\\s*[:\\-]?\\s*(?:${DAY_OF_WEEK})?([A-Za-z]{3,9}\\s+[0-9]{1,2},?\\s+[0-9]{4}|[0-9]{4}-[0-9]{2}-[0-9]{2})`,
  'i',
);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/integrations/parsers/amazon.test.ts`
Expected: PASS — all tests

- [ ] **Step 5: Commit**

```bash
git add backend/src/integrations/parsers/amazon.ts backend/src/integrations/parsers/amazon.test.ts
git commit -m "fix(parsers): DATE_RE handles day-of-week prefix and 'Ordered on'"
```

---

### Task 5: Field-wise parser merge

**Files:**
- Modify: `backend/src/integrations/scanReceipts.ts:168-193` (`parseReceiptText`)
- Test: `backend/src/integrations/parseReceiptTextMerge.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `parseReceiptText` returns `{ extracted, parser, usedAi, aiCapped }` unchanged in shape, but `extracted` may now be a merge of the deterministic and AI results. `parser` becomes `'<name>+ai'` when a merge occurred.

Production shows the two parsers fill disjoint fields — `gmail-scan:ai` has 93% total and 0% last4; `gmail-scan:amazon` has 0% total and 100% last4. Today it is win-or-fallback, never both.

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/integrations/parseReceiptTextMerge.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReceiptText } from './scanReceipts';
import type { ExtractedReceiptOrder } from '../ai/extractReceiptItems';

const aiResult: ExtractedReceiptOrder = {
  vendor: 'amazon',
  vendorName: 'Amazon',
  orderDate: null,
  orderId: '701-1111111-2222222',
  subtotal: null,
  tax: null,
  total: 44.97,
  currency: 'CAD',
  paymentLast4: null,
  tenders: [],
  items: [{ title: 'Widget', quantity: 1, unitPrice: 44.97, totalPrice: 44.97, inferredCategory: null }],
  notes: null,
  trip: null,
};

// Deterministic parser finds last4 but no Order Total line.
const bodyWithLast4NoTotal =
  'Your Amazon.ca order\nOrder # 701-1111111-2222222\nVisa ending in 1001\nQuantity: 1\n$44.97\n';

test('merges the AI total into a deterministic result that lacks one', async () => {
  const out = await parseReceiptText({
    fromAddress: 'auto-confirm@amazon.ca',
    subject: 'Your Amazon.ca order',
    text: bodyWithLast4NoTotal,
    extractFromText: async () => aiResult,
  });

  assert.equal(out.extracted?.paymentLast4, '1001', 'deterministic last4 survives');
  assert.equal(out.extracted?.total, 44.97, 'AI total fills the gap');
  assert.equal(out.usedAi, true);
  assert.equal(out.parser, 'amazon+ai');
});

test('a complete deterministic parse never calls AI', async () => {
  let called = false;
  const complete =
    'Your Amazon.ca order\nOrder # 701-1111111-2222222\nOrder Placed: July 2, 2025\n' +
    'Visa ending in 1001\nOrder Total: $44.97\nQuantity: 1\n$44.97\n';

  const out = await parseReceiptText({
    fromAddress: 'auto-confirm@amazon.ca',
    subject: 'Your Amazon.ca order',
    text: complete,
    extractFromText: async () => {
      called = true;
      return aiResult;
    },
  });

  assert.equal(called, false, 'no AI spend when deterministic is complete');
  assert.equal(out.usedAi, false);
  assert.equal(out.parser, 'amazon');
});

test('the AI budget cap still returns the deterministic result alone', async () => {
  const out = await parseReceiptText({
    fromAddress: 'auto-confirm@amazon.ca',
    subject: 'Your Amazon.ca order',
    text: bodyWithLast4NoTotal,
    extractFromText: async () => aiResult,
    budget: { tryConsume: () => false },
  });

  assert.equal(out.aiCapped, true);
  assert.equal(out.extracted?.paymentLast4, '1001', 'deterministic result is kept, not discarded');
  assert.equal(out.extracted?.total, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/integrations/parseReceiptTextMerge.test.ts`
Expected: FAIL — first test gets `total: null` because the deterministic result short-circuits

- [ ] **Step 3: Write the implementation**

In `backend/src/integrations/scanReceipts.ts`, replace the body of `parseReceiptText` (lines 186-192):

```ts
  const det = tryDeterministicParse({ fromAddress: opts.fromAddress, subject: opts.subject, body: opts.text });
  if (det.ok) return { extracted: det.order, parser: det.parser, usedAi: false, aiCapped: false };
  if (opts.budget && !opts.budget.tryConsume()) {
    return { extracted: null, parser: 'ai', usedAi: false, aiCapped: true };
  }
  const extracted = await opts.extractFromText(opts.text);
  return { extracted, parser: 'ai', usedAi: true, aiCapped: false };
```

with:

```ts
  const det = tryDeterministicParse({ fromAddress: opts.fromAddress, subject: opts.subject, body: opts.text });
  const detOrder = det.ok ? det.order : null;

  // The two parsers fill DISJOINT fields in production: the deterministic Amazon
  // parser gets payment_last4 100% of the time and a total 0% of the time, while
  // the AI extractor gets a total 93% and last4 0%. Win-or-fallback meant neither
  // alone ever produced a matchable record. Run AI only to fill gaps, and let the
  // deterministic value win wherever it is non-null.
  if (detOrder && isCompleteExtract(detOrder)) {
    return { extracted: detOrder, parser: det.ok ? det.parser : 'ai', usedAi: false, aiCapped: false };
  }
  if (opts.budget && !opts.budget.tryConsume()) {
    // Capped: keep whatever the deterministic parser managed rather than dropping it.
    return { extracted: detOrder, parser: det.ok ? det.parser : 'ai', usedAi: false, aiCapped: true };
  }
  const aiOrder = await opts.extractFromText(opts.text);
  if (!detOrder) return { extracted: aiOrder, parser: 'ai', usedAi: true, aiCapped: false };
  return {
    extracted: mergeExtracts(detOrder, aiOrder),
    parser: `${det.ok ? det.parser : 'ai'}+ai`,
    usedAi: true,
    aiCapped: false,
  };
```

Add these two helpers immediately above `parseReceiptText` in the same file:

```ts
/** A deterministic parse worth trusting on its own — no AI gap-fill needed. */
function isCompleteExtract(o: ExtractedReceiptOrder): boolean {
  return o.total != null && o.orderDate != null && o.items.length > 0;
}

/**
 * Field-wise merge: the deterministic parser wins wherever it produced a value,
 * the AI fills the holes. Items come from whichever side has more of them —
 * never concatenated, which would double the order.
 */
function mergeExtracts(
  det: ExtractedReceiptOrder,
  ai: ExtractedReceiptOrder,
): ExtractedReceiptOrder {
  return {
    ...det,
    vendorName: det.vendorName ?? ai.vendorName,
    orderDate: det.orderDate ?? ai.orderDate,
    orderId: det.orderId ?? ai.orderId,
    subtotal: det.subtotal ?? ai.subtotal,
    tax: det.tax ?? ai.tax,
    total: det.total ?? ai.total,
    currency: det.currency ?? ai.currency,
    paymentLast4: det.paymentLast4 ?? ai.paymentLast4,
    items: det.items.length >= ai.items.length ? det.items : ai.items,
    notes: det.notes ?? ai.notes,
    trip: det.trip ?? ai.trip,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/integrations/parseReceiptTextMerge.test.ts`
Expected: PASS, 3 tests

Then the full integrations suite, since `parseReceiptText` has many callers:
Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/integrations/*.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/integrations/scanReceipts.ts backend/src/integrations/parseReceiptTextMerge.test.ts
git commit -m "feat(integrations): merge deterministic and AI parser output field-wise

The two parsers fill disjoint fields — deterministic gets last4 100% and
total 0%, AI gets total 93% and last4 0% — so win-or-fallback meant
neither alone produced a matchable record. AI now runs only to fill gaps."
```

---

### Task 6: AI schema declares `subtotal` and `tax`

**Files:**
- Modify: `backend/src/ai/extractReceiptItems.ts:63-101` (`SYSTEM_PROMPT`)
- Test: `backend/src/ai/extractReceiptItems.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `parseExtractedReceipt` can return non-null `subtotal`/`tax`.

`parseExtractedReceipt` reads `j.subtotal` and `j.tax`, but the schema in the prompt never mentions them, so the model never emits them and both are permanently null.

- [ ] **Step 1: Write the failing test**

```ts
// append to backend/src/ai/extractReceiptItems.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SYSTEM_PROMPT, parseExtractedReceipt } from './extractReceiptItems';

test('the schema in the system prompt declares subtotal and tax', () => {
  assert.match(SYSTEM_PROMPT, /"subtotal":/);
  assert.match(SYSTEM_PROMPT, /"tax":/);
});

test('parseExtractedReceipt surfaces subtotal and tax when the model emits them', () => {
  const r = parseExtractedReceipt({ subtotal: 39.97, tax: 5.0, total: 44.97, items: [] });
  assert.equal(r.subtotal, 39.97);
  assert.equal(r.tax, 5.0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/ai/extractReceiptItems.test.ts --test-name-pattern 'subtotal'`
Expected: FAIL — `SYSTEM_PROMPT` does not match `/"subtotal":/`

If `SYSTEM_PROMPT` is not currently exported, add `export` to its declaration.

- [ ] **Step 3: Write the implementation**

In the `SYSTEM_PROMPT` schema block, insert two lines immediately after the `"total"` line:

```
  "total": number | null,
  "subtotal": number | null,
  "tax": number | null,
  "currency": "USD" | "CAD" | "EUR" | "GBP" | "AUD" | null,
```

And add one line to the `Rules:` list:

```
- "subtotal" is the pre-tax order total and "tax" the tax charged. Null if the receipt doesn't state them separately — never compute one from the other.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/ai/extractReceiptItems.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/ai/extractReceiptItems.ts backend/src/ai/extractReceiptItems.test.ts
git commit -m "fix(ai): declare subtotal and tax in the receipt extraction schema

parseExtractedReceipt already read j.subtotal and j.tax, but the schema
never mentioned them so the model never emitted them."
```

---

### Task 7: `forceReprocess` for the existing 141 orders

**Files:**
- Modify: `backend/src/integrations/scanReceipts.ts` — `scanInbox` opts (~:421-431) and the seen-set guard (~:472-482) and the `findOrCreate` block (~:696)
- Test: `backend/src/integrations/scanReceiptsReprocess.test.ts`

**Interfaces:**
- Consumes: `dateFromInternalDate` (Task 1).
- Produces: `scanInbox({ ..., forceReprocessMessageIds?: string[] })`. When supplied, those ids bypass the `ProcessedEmailMessage` skip, and an existing `ExternalOrder` has its **null fields only** backfilled.

Raw bodies are not retained, but the Gmail message id is — in `ExternalOrder.rawPayload.gmailMessageId` and `ProcessedEmailMessage.messageId`. `findOrCreate` ignores `defaults` on an existing row, so this needs an explicit update.

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/integrations/scanReceiptsReprocess.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExternalOrder, ProcessedEmailMessage } from '../models';
import { scanInbox } from './scanReceipts';

const ACCESS = { userId: 1, householdId: 1 };
const BODY =
  'Your Amazon.ca order\nOrder # 701-9999999-8888888\nOrder Total: $44.97\nQuantity: 1\n$44.97\n';

function msg() {
  return {
    id: 'msg-repro',
    internalDate: '1756391531000', // 2025-08-28
    labelIds: [],
    payload: {
      headers: [
        { name: 'From', value: 'auto-confirm@amazon.ca' },
        { name: 'Subject', value: 'Your Amazon.ca order' },
      ],
      body: { data: Buffer.from(BODY).toString('base64url') },
    },
  };
}

const deps = {
  listMessageIds: async () => [{ id: 'msg-repro' }],
  fetchMessage: async () => msg() as never,
  extractFromText: async () => {
    throw new Error('deterministic parser should have handled this');
  },
};

test('a seen message is skipped without forceReprocess', async () => {
  await ProcessedEmailMessage.create({
    householdId: 1, provider: 'google', messageId: 'msg-repro',
    status: 'extracted', parser: 'amazon', externalOrderId: null,
    errorMessage: null, subject: null, fromAddr: null, scannedAt: new Date(),
  } as never);

  const r = await scanInbox(ACCESS, {}, deps);
  assert.equal(r.skippedAlreadySeen, 1);
});

test('forceReprocess backfills null fields on an existing order', async () => {
  const order = await ExternalOrder.create({
    householdId: 1, vendor: 'amazon', vendorOrderId: '701-9999999-8888888',
    dedupeKey: 'amazon:701-9999999-8888888:44.97:1:msg-repro',
    orderDate: null, total: '44.97', currency: 'CAD', paymentLast4: null,
    source: 'gmail-scan:ai', rawPayload: { gmailMessageId: 'msg-repro' },
  } as never);

  await scanInbox({ ...ACCESS, forceReprocessMessageIds: ['msg-repro'] }, {}, deps);

  await order.reload();
  assert.equal(order.orderDate, '2025-08-28', 'null order date is backfilled');
});

test('forceReprocess never overwrites a non-null field', async () => {
  const order = await ExternalOrder.create({
    householdId: 1, vendor: 'amazon', vendorOrderId: '701-7777777-6666666',
    dedupeKey: 'amazon:701-9999999-8888888:44.97:1:msg-repro',
    orderDate: '2020-01-01', total: '99.99', currency: 'CAD', paymentLast4: '4321',
    source: 'gmail-scan:ai', rawPayload: { gmailMessageId: 'msg-repro' },
  } as never);

  await scanInbox({ ...ACCESS, forceReprocessMessageIds: ['msg-repro'] }, {}, deps);

  await order.reload();
  assert.equal(order.orderDate, '2020-01-01', 'a user-corrected date survives');
  assert.equal(order.total, '99.99');
  assert.equal(order.paymentLast4, '4321');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/integrations/scanReceiptsReprocess.test.ts`
Expected: FAIL — `forceReprocessMessageIds` is not a recognised option; the order date stays null

- [ ] **Step 3: Add the option and bypass the skip**

In `scanInbox`'s opts type (~line 421), add:

```ts
    /**
     * Gmail message ids to re-parse even though ProcessedEmailMessage has
     * already seen them. Used to backfill orders written before a parser fix —
     * the raw body is not retained, so the message is re-fetched from Gmail.
     * Existing ExternalOrder rows get NULL fields filled in; non-null fields are
     * never overwritten, since the user may have corrected them.
     */
    forceReprocessMessageIds?: string[];
```

Immediately after the `seen` set is populated (~line 482), add:

```ts
  for (const id of opts.forceReprocessMessageIds ?? []) seen.delete(id);
```

- [ ] **Step 4: Backfill null fields on an existing order**

In the `findOrCreate` block (~line 696), after `result.orderCreated = createdOrder;`, add:

```ts
        if (!createdOrder) {
          // Reprocess: fill holes only. Never clobber a value already present —
          // it may have been corrected by hand.
          const backfill: Record<string, unknown> = {};
          const fallbackDate = extracted!.orderDate ?? dateFromInternalDate(full.internalDate);
          if (order.orderDate == null && fallbackDate != null) backfill.orderDate = fallbackDate;
          if (order.total == null && extracted!.total != null) backfill.total = String(extracted!.total);
          if (order.subtotal == null && extracted!.subtotal != null) backfill.subtotal = String(extracted!.subtotal);
          if (order.tax == null && extracted!.tax != null) backfill.tax = String(extracted!.tax);
          if (order.paymentLast4 == null && extracted!.paymentLast4 != null) {
            backfill.paymentLast4 = extracted!.paymentLast4;
          }
          if (order.vendorOrderId == null && extracted!.orderId != null) {
            backfill.vendorOrderId = extracted!.orderId;
          }
          if (Object.keys(backfill).length > 0) {
            await order.update(backfill, { transaction: t });
          }
        }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/integrations/scanReceiptsReprocess.test.ts`
Expected: PASS, 3 tests

- [ ] **Step 6: Commit**

```bash
git add backend/src/integrations/scanReceipts.ts backend/src/integrations/scanReceiptsReprocess.test.ts
git commit -m "feat(integrations): forceReprocess to backfill orders after a parser fix

Raw bodies are not retained but the Gmail message id is, so an order
written by an older parser can be re-fetched and re-parsed. findOrCreate
ignores defaults on an existing row, so this fills null fields
explicitly — and never overwrites one that already has a value."
```

---

## Group B — Auto-accept wiring

*Unlocks 15 transactions already sitting at confidence 88.*

### Task 8: Give `backfillAutoAcceptAmazonLinks` a caller

**Files:**
- Modify: `backend/src/amazon/matcher.ts:189-262` (`runAmazonMatching`)
- Test: `backend/src/amazon/backfillAutoAcceptLinks.test.ts`

**Interfaces:**
- Consumes: `backfillAutoAcceptAmazonLinks({ householdId }): Promise<{ promoted: number; examined: number }>` from `./backfillAutoAcceptLinks`. Its signature does **not** change — it already returns `promoted` and already calls `recomputeTransactionsReviewFromItems` internally for the orders it accepts.
- Produces: `runAmazonMatching` returns `autoAccepted` including links promoted by the backfill.

The function already implements the correct rule. It has **zero non-test callers** — no route, no job — which is why 15 links sit at average confidence 88 with none accepted.

- [ ] **Step 1: Write the failing test**

```ts
// append to backend/src/amazon/backfillAutoAcceptLinks.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExternalOrder, Transaction, TransactionOrderLink } from '../models';
import { runAmazonMatching } from './matcher';

test('runAmazonMatching promotes pre-existing high-confidence suggested links', async () => {
  const txn = await Transaction.create({
    householdId: 1, accountId: 1, date: '2025-08-28', amount: '-44.97',
    merchantRaw: 'AMZN MKTP CA*Z90R91K22', merchantClean: 'Amazon',
  } as never);
  const order = await ExternalOrder.create({
    householdId: 1, vendor: 'amazon', vendorOrderId: '701-1111111-2222222',
    dedupeKey: 'k1', orderDate: '2025-08-27', total: '44.97', currency: 'CAD',
    source: 'amazon_report',
  } as never);
  // A link created before auto-accept existed: high confidence, still suggested.
  await TransactionOrderLink.create({
    transactionId: txn.id, externalOrderId: order.id,
    confidence: '88.00', matchReason: 'legacy', status: 'suggested',
  } as never);

  const result = await runAmazonMatching({ householdId: 1 });

  const link = await TransactionOrderLink.findOne({
    where: { transactionId: txn.id, externalOrderId: order.id },
  });
  assert.equal(link?.status, 'accepted');
  assert.equal(result.autoAccepted >= 1, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/amazon/backfillAutoAcceptLinks.test.ts --test-name-pattern 'pre-existing'`
Expected: FAIL — link status is still `'suggested'`

- [ ] **Step 3: Write the implementation**

In `backend/src/amazon/matcher.ts`, add the import:

```ts
import { backfillAutoAcceptAmazonLinks } from './backfillAutoAcceptLinks';
```

In `runAmazonMatching`, immediately **after** the existing
`recomputeTransactionsReviewFromItems` loop and before the `return`, add:

```ts
  // Reconcile links created before auto-accept existed. upsertSuggestedOrderLink
  // only promotes rows it touches during THIS scan, so a suggested row whose
  // transaction no longer produces a candidate would stay pending forever.
  // The backfill runs its own review recompute for the orders it accepts, which
  // is why it goes after the loop rather than feeding into it.
  const backfilled = await backfillAutoAcceptAmazonLinks({ householdId: args.householdId });
  autoAccepted += backfilled.promoted;
```

Do **not** change `backfillAutoAcceptAmazonLinks`. It already returns
`{ promoted, examined }` and already calls
`recomputeTransactionsReviewFromItems(await transactionIdsForOrder(orderId))`
for every order it accepts.

Watch for an import cycle: `backfillAutoAcceptLinks.ts` imports
`isAmazonLikeMerchant` from `matcher.ts`, and `matcher.ts` will now import
`backfillAutoAcceptAmazonLinks` back. Node ESM tolerates this because both are
function declarations resolved at call time, but if the test run reports a
`Cannot access '...' before initialization`, move `isAmazonLikeMerchant` into a
small `backend/src/amazon/merchant.ts` and have both files import it from there.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/amazon/backfillAutoAcceptLinks.test.ts src/amazon/matcher.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/amazon/matcher.ts backend/src/amazon/backfillAutoAcceptLinks.ts backend/src/amazon/backfillAutoAcceptLinks.test.ts
git commit -m "fix(amazon): call backfillAutoAcceptAmazonLinks from runAmazonMatching

The function implemented the right rule and had zero non-test callers,
which is why 15 production links sat at average confidence 88 with none
accepted while costco and uber_eats links accepted normally."
```

---

## Group C — Merge duplicate orders

*Unlocks 9 transactions.*

### Task 9: Fold `amazon_report` and email rows sharing a `vendor_order_id`

**Files:**
- Create: `backend/src/amazon/mergeDuplicateOrders.ts`
- Test: `backend/src/amazon/mergeDuplicateOrders.test.ts`
- Modify: `backend/src/amazon/matcher.ts` — call it at the start of `runAmazonMatching`

**Interfaces:**
- Consumes: nothing.
- Produces: `mergeDuplicateAmazonOrders({ householdId }): Promise<{ merged: number }>`.

Of 75 `vendor_order_id`s present in both sources, 16 have `report_total < gmail_total`, and in those cases the **email** total equals the card charge exactly. The CSV row carries a per-shipment partial. Email wins.

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/amazon/mergeDuplicateOrders.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExternalOrder, ExternalOrderItem } from '../models';
import { mergeDuplicateAmazonOrders } from './mergeDuplicateOrders';

async function seedPair() {
  const report = await ExternalOrder.create({
    householdId: 1, vendor: 'amazon', vendorOrderId: '701-6488283-5477862',
    dedupeKey: 'r1', orderDate: '2025-08-27', total: '10.11', currency: 'CAD',
    paymentLast4: '1001', source: 'amazon_report',
  } as never);
  const email = await ExternalOrder.create({
    householdId: 1, vendor: 'amazon', vendorOrderId: '701-6488283-5477862',
    dedupeKey: 'e1', orderDate: null, total: '38.26', currency: 'CAD',
    paymentLast4: null, source: 'gmail-scan:ai',
  } as never);
  await ExternalOrderItem.create({
    externalOrderId: report.id, title: 'Widget', quantity: 1,
    unitPrice: '10.11', totalPrice: '10.11',
  } as never);
  await ExternalOrderItem.create({
    externalOrderId: email.id, title: 'Gadget', quantity: 1,
    unitPrice: '28.15', totalPrice: '28.15',
  } as never);
  return { report, email };
}

test('the larger email total wins over the partial CSV total', async () => {
  const { report } = await seedPair();
  const out = await mergeDuplicateAmazonOrders({ householdId: 1 });
  assert.equal(out.merged, 1);

  const survivors = await ExternalOrder.findAll({
    where: { householdId: 1, vendorOrderId: '701-6488283-5477862' },
  });
  assert.equal(survivors.length, 1);
  assert.equal(survivors[0].id, report.id, 'the older row survives, carrying merged values');
  assert.equal(survivors[0].total, '38.26');
});

test('non-null order date and last4 survive the merge', async () => {
  await seedPair();
  await mergeDuplicateAmazonOrders({ householdId: 1 });
  const survivor = await ExternalOrder.findOne({
    where: { householdId: 1, vendorOrderId: '701-6488283-5477862' },
  });
  assert.equal(survivor?.orderDate, '2025-08-27', 'from the report row');
  assert.equal(survivor?.paymentLast4, '1001', 'from the report row');
});

test('items are unioned onto the survivor', async () => {
  await seedPair();
  await mergeDuplicateAmazonOrders({ householdId: 1 });
  const survivor = await ExternalOrder.findOne({
    where: { householdId: 1, vendorOrderId: '701-6488283-5477862' },
  });
  const items = await ExternalOrderItem.findAll({ where: { externalOrderId: survivor!.id } });
  assert.deepEqual(items.map((i) => i.title).sort(), ['Gadget', 'Widget']);
});

test('orders without a vendorOrderId are left alone', async () => {
  await ExternalOrder.create({
    householdId: 1, vendor: 'amazon', vendorOrderId: null, dedupeKey: 'n1',
    orderDate: '2025-08-27', total: '5.00', currency: 'CAD', source: 'gmail-scan:ai',
  } as never);
  await ExternalOrder.create({
    householdId: 1, vendor: 'amazon', vendorOrderId: null, dedupeKey: 'n2',
    orderDate: '2025-08-27', total: '5.00', currency: 'CAD', source: 'gmail-scan:ai',
  } as never);

  const out = await mergeDuplicateAmazonOrders({ householdId: 1 });
  assert.equal(out.merged, 0);
  assert.equal(await ExternalOrder.count({ where: { householdId: 1, vendorOrderId: null } }), 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/amazon/mergeDuplicateOrders.test.ts`
Expected: FAIL — `Cannot find module './mergeDuplicateOrders'`

- [ ] **Step 3: Write the implementation**

```ts
// backend/src/amazon/mergeDuplicateOrders.ts
import { Op } from 'sequelize';
import { sequelize } from '../db';
import { ExternalOrder, ExternalOrderItem, TransactionOrderLink } from '../models';
import { logger } from '../observability/logger';

/**
 * Fold Amazon orders that share a vendorOrderId into one row.
 *
 * The `amazon_report` CSV and the receipt email are two views of the same order,
 * and today they compete as separate ExternalOrders. Production shows the CSV
 * row carries a PER-SHIPMENT PARTIAL total while the email carries the full
 * order total that matches the card charge: of 75 shared order ids, 16 have
 * report_total < gmail_total, and in those cases the email total equals the
 * charge exactly. So the larger total wins.
 *
 * Orders with a null vendorOrderId are untouched — `amazonOrderDedupeKey`
 * already handles those.
 */
export async function mergeDuplicateAmazonOrders(args: {
  householdId: number;
}): Promise<{ merged: number }> {
  const orders = await ExternalOrder.findAll({
    where: {
      householdId: args.householdId,
      vendor: 'amazon',
      vendorOrderId: { [Op.ne]: null },
    },
    order: [['id', 'ASC']],
  });

  const groups = new Map<string, ExternalOrder[]>();
  for (const o of orders) {
    const key = String(o.vendorOrderId);
    const list = groups.get(key) ?? [];
    list.push(o);
    groups.set(key, list);
  }

  let merged = 0;
  for (const [vendorOrderId, group] of groups) {
    if (group.length < 2) continue;

    // Oldest row survives so existing TransactionOrderLinks keep pointing at it.
    const [survivor, ...losers] = group;

    await sequelize.transaction(async (t) => {
      const maxTotal = group
        .map((o) => (o.total == null ? null : Number(o.total)))
        .filter((n): n is number => n != null && Number.isFinite(n))
        .reduce<number | null>((best, n) => (best == null || n > best ? n : best), null);

      await survivor.update(
        {
          total: maxTotal != null ? String(maxTotal.toFixed(2)) : survivor.total,
          orderDate: survivor.orderDate ?? group.find((o) => o.orderDate != null)?.orderDate ?? null,
          paymentLast4:
            survivor.paymentLast4 ?? group.find((o) => o.paymentLast4 != null)?.paymentLast4 ?? null,
          subtotal: survivor.subtotal ?? group.find((o) => o.subtotal != null)?.subtotal ?? null,
          tax: survivor.tax ?? group.find((o) => o.tax != null)?.tax ?? null,
        },
        { transaction: t },
      );

      for (const loser of losers) {
        // Union items by title+totalPrice so a re-run does not duplicate them.
        const [survivorItems, loserItems] = await Promise.all([
          ExternalOrderItem.findAll({ where: { externalOrderId: survivor.id }, transaction: t }),
          ExternalOrderItem.findAll({ where: { externalOrderId: loser.id }, transaction: t }),
        ]);
        const have = new Set(survivorItems.map((i) => `${i.title}|${i.totalPrice}`));
        for (const item of loserItems) {
          if (have.has(`${item.title}|${item.totalPrice}`)) {
            await item.destroy({ transaction: t });
          } else {
            await item.update({ externalOrderId: survivor.id }, { transaction: t });
          }
        }
        await TransactionOrderLink.destroy({
          where: { externalOrderId: loser.id },
          transaction: t,
        });
        await loser.destroy({ transaction: t });
      }
      merged += 1;
    });

    logger.info({ vendorOrderId, folded: losers.length }, 'amazon_duplicate_orders_merged');
  }

  return { merged };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/amazon/mergeDuplicateOrders.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Call it from `runAmazonMatching`**

In `backend/src/amazon/matcher.ts`, add the import:

```ts
import { mergeDuplicateAmazonOrders } from './mergeDuplicateOrders';
```

As the first statement inside `runAmazonMatching`, before the `Transaction.findAll`:

```ts
  // Fold CSV/email duplicates before scoring so a partial CSV total never
  // competes with the full email total for the same order.
  await mergeDuplicateAmazonOrders({ householdId: args.householdId });
```

- [ ] **Step 6: Run the amazon suite**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/amazon/*.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add backend/src/amazon/mergeDuplicateOrders.ts \
        backend/src/amazon/mergeDuplicateOrders.test.ts \
        backend/src/amazon/matcher.ts
git commit -m "feat(amazon): merge duplicate orders sharing a vendorOrderId

The amazon_report CSV row carries a per-shipment partial total while the
receipt email carries the full order total that matches the card charge —
16 of 75 shared order ids differ this way. Larger total wins."
```

---

## Group D — Card ownership resolver

### Task 10: The resolver

**Files:**
- Create: `backend/src/amazon/cardOwnership.ts`
- Test: `backend/src/amazon/cardOwnership.test.ts`

**Interfaces:**
- Consumes: nothing (pure — takes plain objects, not model instances).
- Produces:
  - `resolveAccountLast4(shortCode: string | null): string | null`
  - `buildLast4Map(accounts: { id: number; shortCode: string | null }[]): Map<string, number[]>`
  - `classifyCardOwnership(paymentLast4: string | null, map: Map<string, number[]>): CardOwnership`
  - `type CardOwnership = 'known' | 'foreign' | 'unknown'`

`accounts.bank_account_number` is empty on all 29 accounts. `short_code` is the sole card identifier and holds the last4 as a **suffix** in three formats: Amex `701001` → 1001, RBC `5234` → 5234, Wealthsimple `HQ6LMLTK8CAD` → none.

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/amazon/cardOwnership.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAccountLast4, buildLast4Map, classifyCardOwnership } from './cardOwnership';

test('extracts the last 4 digits from an all-numeric short code', () => {
  assert.equal(resolveAccountLast4('701001'), '1001'); // Amex Reserve
  assert.equal(resolveAccountLast4('741005'), '1005'); // Amex Cobalt
  assert.equal(resolveAccountLast4('5234'), '5234');   // RBC Avion
});

test('returns null for opaque alphanumeric short codes', () => {
  assert.equal(resolveAccountLast4('HQ6LMLTK8CAD'), null); // Wealthsimple
  assert.equal(resolveAccountLast4('costco'), null);
  assert.equal(resolveAccountLast4('C13BRX957CAD'), null);
});

test('returns null for null, empty and too-short codes', () => {
  assert.equal(resolveAccountLast4(null), null);
  assert.equal(resolveAccountLast4(''), null);
  assert.equal(resolveAccountLast4('123'), null);
});

test('classifies an order against the household map', () => {
  const map = buildLast4Map([
    { id: 1, shortCode: '701001' },
    { id: 40, shortCode: '741005' },
    { id: 8, shortCode: 'HQ6LMLTK8CAD' },
  ]);

  assert.equal(classifyCardOwnership('1001', map), 'known');
  assert.equal(classifyCardOwnership('1005', map), 'known');
  assert.equal(classifyCardOwnership('2662', map), 'foreign');
  assert.equal(classifyCardOwnership(null, map), 'unknown');
});

test('two accounts sharing a last4 still classify as known', () => {
  const map = buildLast4Map([
    { id: 1, shortCode: '701001' },
    { id: 2, shortCode: '881001' },
  ]);
  assert.deepEqual(map.get('1001'), [1, 2]);
  assert.equal(classifyCardOwnership('1001', map), 'known');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/amazon/cardOwnership.test.ts`
Expected: FAIL — `Cannot find module './cardOwnership'`

- [ ] **Step 3: Write the implementation**

```ts
// backend/src/amazon/cardOwnership.ts
/**
 * Resolve which Cashflow account a card last-4 belongs to.
 *
 * `accounts.bank_account_number` is empty on every account, so `short_code` is
 * the sole card identifier — and it holds the last4 as a SUFFIX in three
 * incompatible formats: Amex writes 6 digits ('701001' -> 1001), RBC and Wise
 * write the bare 4 ('5234'), and Wealthsimple writes an opaque alphanumeric
 * account id ('HQ6LMLTK8CAD') that carries no card number at all.
 *
 * Two consumers:
 *   - the Amazon matcher, where this replaces a dead text-scrape of
 *     txn.notes/sourceReference (0 hits across 111 production transactions);
 *   - foreign-card exclusion, where 291 of 538 orders carry a last4 belonging
 *     to no account.
 *
 * Pure: takes plain objects, never model instances, so it is trivially testable.
 */
export type CardOwnership = 'known' | 'foreign' | 'unknown';

/** The card last-4 an account's short code encodes, or null when it encodes none. */
export function resolveAccountLast4(shortCode: string | null): string | null {
  if (shortCode == null) return null;
  const trimmed = shortCode.trim();
  if (!/^\d{4,}$/.test(trimmed)) return null;
  return trimmed.slice(-4);
}

/** last4 -> account ids. A last4 shared by two accounts maps to both. */
export function buildLast4Map(
  accounts: { id: number; shortCode: string | null }[],
): Map<string, number[]> {
  const map = new Map<string, number[]>();
  for (const account of accounts) {
    const last4 = resolveAccountLast4(account.shortCode);
    if (last4 == null) continue;
    const ids = map.get(last4) ?? [];
    ids.push(account.id);
    map.set(last4, ids);
  }
  return map;
}

/**
 * `unknown` is deliberately NOT `foreign`: absence of a last4 is not evidence of
 * a foreign card. 135 of 538 production orders have no last4 and most are the
 * user's own, so they stay matchable and counted — just badged.
 */
export function classifyCardOwnership(
  paymentLast4: string | null,
  map: Map<string, number[]>,
): CardOwnership {
  if (paymentLast4 == null || paymentLast4 === '') return 'unknown';
  return map.has(paymentLast4) ? 'known' : 'foreign';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/amazon/cardOwnership.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add backend/src/amazon/cardOwnership.ts backend/src/amazon/cardOwnership.test.ts
git commit -m "feat(amazon): add card ownership resolver over accounts.short_code"
```

---

### Task 11: Account-derived last4 in the matcher — **with the tie guard, same commit**

**Files:**
- Modify: `backend/src/amazon/matcher.ts:25` (delete `last4FromText`), `:64-84` (`selectMatchCandidates`), `:125` (last4 scoring), `:189+` (load the map)
- Test: `backend/src/amazon/matcher.test.ts`

**Interfaces:**
- Consumes: `buildLast4Map`, `resolveAccountLast4` from Task 10.
- Produces: `scoreAmazonOrderMatch(txn, order, txnLast4: string | null)` — **signature change**, third parameter added. Update `linkItemsStage.ts:101`, which also calls it.

**This task's two halves must land in one commit.** Turning the last4 signal on without the tie guard pushes exact-cent candidates from Task 3 into the `strong` tier (50 + 15 + 20 = 85 ≥ 70), which returns **every** candidate and reintroduces the historical fan-out.

- [ ] **Step 1: Write the failing test**

```ts
// append to backend/src/amazon/matcher.test.ts
test('the last4 bonus comes from the account, not from txn text', () => {
  const order = { total: '44.97', orderDate: '2025-08-27', shipmentDate: null, paymentLast4: '1001', currency: 'CAD' } as never;
  const withAccount = scoreAmazonOrderMatch(txn, order, '1001');
  const withoutAccount = scoreAmazonOrderMatch(txn, order, null);
  assert.equal(withAccount.confidence > withoutAccount.confidence, true);
  assert.match(withAccount.matchReason, /last4 matches/);
});

test('two exact-cent orders on the SAME card abstain instead of fanning out', () => {
  // Both score 50 + 15 + 20 = 85, which clears the strong threshold.
  const order = { total: '44.97', orderDate: null, shipmentDate: null, paymentLast4: '1001', currency: 'CAD' } as never;
  const a = scoreAmazonOrderMatch(txn, order, '1001');
  const b = scoreAmazonOrderMatch(txn, order, '1001');
  assert.equal(a.confidence >= 70, true, 'precondition: these are in the strong tier');

  const picked = selectMatchCandidates([
    { id: 'a', confidence: a.confidence, secondary: a.secondaryScore },
    { id: 'b', confidence: b.confidence, secondary: b.secondaryScore },
  ]);
  assert.equal(picked.length, 0, 'strong-tier tie must abstain, not fan out');
});

test('a genuine multi-order charge at different strong scores still returns all', () => {
  const picked = selectMatchCandidates([
    { id: 'a', confidence: 90, secondary: 20 },
    { id: 'b', confidence: 75, secondary: 0 },
  ]);
  assert.equal(picked.length, 2, 'different scores — not a tie, preserve multi-order behaviour');
});

test('a resolvable strong tie keeps the winner plus strictly-lower candidates', () => {
  const picked = selectMatchCandidates([
    { id: 'tieWinner', confidence: 85, secondary: 20 },
    { id: 'tieLoser', confidence: 85, secondary: 0 },
    { id: 'lower', confidence: 75, secondary: 0 },
  ]);
  assert.deepEqual(picked.map((p) => (p as { id: string }).id).sort(), ['lower', 'tieWinner']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/amazon/matcher.test.ts --test-name-pattern 'last4 bonus|SAME card|multi-order|resolvable'`
Expected: FAIL — `scoreAmazonOrderMatch` takes 2 arguments; the same-card test fans out to 2 candidates

- [ ] **Step 3: Extract the tie-break and guard the strong tier**

In `backend/src/amazon/matcher.ts`, add above `selectMatchCandidates`:

```ts
/**
 * Resolve a set of candidates tied at the same confidence using the
 * unambiguous-identity secondary score (exact-cent amount, date proximity,
 * last4). Returns the sole leader, or [] when the tie is unresolvable —
 * abstaining rather than guessing.
 */
function resolveTie<T extends { confidence: number; secondary?: number }>(tied: T[]): T[] {
  if (tied.length <= 1) return tied;
  const bestSecondary = Math.max(...tied.map((c) => c.secondary ?? 0));
  if (bestSecondary > 0) {
    const leaders = tied.filter((c) => (c.secondary ?? 0) === bestSecondary);
    if (leaders.length === 1) return leaders;
  }
  return [];
}
```

Replace `selectMatchCandidates`' body:

```ts
export function selectMatchCandidates<T extends { confidence: number; secondary?: number }>(scored: T[]): T[] {
  const strong = scored.filter((candidate) => candidate.confidence >= MATCH_CONFIDENCE_THRESHOLD);
  if (strong.length > 0) {
    // The strong tier intentionally returns MULTIPLE candidates — one charge can
    // legitimately span several orders. But once the account-derived last4 bonus
    // exists, two exact-cent orders on the same card both reach 85 and tie, and
    // returning both is the historical fan-out. Guard the top tie only: a tie is
    // resolved on secondary, or abstained on. Strictly-lower strong candidates
    // are untouched, preserving genuine multi-order behaviour.
    const sortedStrong = [...strong].sort((a, b) => b.confidence - a.confidence);
    const topScore = sortedStrong[0].confidence;
    const tiedAtTop = sortedStrong.filter((c) => c.confidence === topScore);
    if (tiedAtTop.length > 1) {
      const resolved = resolveTie(tiedAtTop);
      if (resolved.length === 0) return [];
      return [...resolved, ...sortedStrong.filter((c) => c.confidence < topScore)];
    }
    return strong;
  }

  const sorted = [...scored].sort((a, b) => b.confidence - a.confidence);
  const best = sorted[0];
  if (!best || best.confidence < FALLBACK_MIN_CONFIDENCE) return [];
  const tiedAtBest = sorted.filter((candidate) => candidate.confidence === best.confidence);
  if (tiedAtBest.length > 1) return resolveTie(tiedAtBest);
  return [best];
}
```

- [ ] **Step 4: Replace the text-scraped last4 with the account-derived one**

Delete `last4FromText` (line 25) entirely — it has no other callers.

Change `scoreAmazonOrderMatch`'s signature:

```ts
export function scoreAmazonOrderMatch(
  txn: Transaction,
  order: ExternalOrder,
  /**
   * The last-4 of the card the transaction was charged to, resolved from the
   * account's short_code. Previously scraped from txn.notes/sourceReference,
   * which matched 0 of 111 production Amazon transactions while 403 of 538
   * orders carry a payment_last4 — the join could never fire.
   */
  txnLast4: string | null,
): MatchScore {
```

Replace the last4 block (lines ~124-129):

```ts
  const txnLast4 = last4FromText(`${txn.notes || ''} ${txn.sourceReference || ''}`);
  if (txnLast4 && order.paymentLast4 && txnLast4 === order.paymentLast4) {
    score += 20;
    secondary += 20;
    reasons.push('payment last4 matches');
  }
```

with:

```ts
  if (txnLast4 && order.paymentLast4) {
    if (txnLast4 === order.paymentLast4) {
      score += 20;
      secondary += 20;
      reasons.push('payment last4 matches');
    }
    // NOTE: the mismatch penalty lives in Task 12, gated on production
    // verification. Do not add it here.
  }
```

In `runAmazonMatching`, load the account last4s once before the transaction loop:

```ts
  const accounts = await Account.findAll({
    where: { householdId: args.householdId },
    attributes: ['id', 'shortCode'],
  });
  const last4ByAccountId = new Map<number, string | null>(
    accounts.map((a) => [a.id, resolveAccountLast4(a.shortCode)]),
  );
```

and pass it at the call site:

```ts
    const scores = orders.map((order) => {
      const { confidence, matchReason, secondaryScore } = scoreAmazonOrderMatch(
        txn,
        order,
        last4ByAccountId.get(txn.accountId) ?? null,
      );
      return { order, confidence, matchReason, secondary: secondaryScore };
    });
```

Add the imports:

```ts
import { Account } from '../models';
import { resolveAccountLast4 } from './cardOwnership';
```

- [ ] **Step 5: Update the other caller**

`backend/src/import/enrichment/linkItemsStage.ts:101` also calls `scoreAmazonOrderMatch`. Pass `null` as the third argument for now — the enrichment stage is vendor-agnostic and has no account context in scope:

```ts
      const { confidence, matchReason } = scoreAmazonOrderMatch(txn, order, null);
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/amazon/matcher.test.ts`
Expected: PASS

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/import/enrichment/linkItemsStage.test.ts`
Expected: PASS

Run: `yarn workspace cashflow-backend run typecheck`
Expected: no errors

- [ ] **Step 7: Commit — both halves together**

```bash
git add backend/src/amazon/matcher.ts backend/src/amazon/matcher.test.ts \
        backend/src/import/enrichment/linkItemsStage.ts
git commit -m "feat(amazon): derive match last4 from the account, guard strong-tier ties

last4FromText scraped txn.notes/sourceReference and matched 0 of 111
production Amazon transactions, while 403 of 538 orders carry a
payment_last4 — the join could never fire. The card number is on
accounts.short_code as a suffix.

The tie guard ships in the same commit by necessity: with the last4 bonus
live, two exact-cent orders on one card both reach 85 and enter the
strong tier, which returned every candidate. Top-tie is now resolved on
secondary score or abstained on; strictly-lower strong candidates are
untouched so genuine multi-order charges still work."
```

---

### Task 12: Last4 mismatch penalty — **gated on production verification**

**Files:**
- Modify: `backend/src/amazon/matcher.ts` — the last4 block from Task 11
- Test: `backend/src/amazon/matcher.test.ts`

**Interfaces:**
- Consumes: Task 11's `txnLast4` parameter.
- Produces: no signature change.

This is the one change in the plan with real downside: a stale or mis-parsed `payment_last4` on an order would suppress a genuine match.

- [ ] **Step 1: Verify against production first**

Using the `cashflow-prod-db` skill, read-only, count how many **currently accepted or suggested** Amazon links have a `payment_last4` on the order that differs from the last-4 of the transaction's account short code.

Expected: **0**, since all 15 suggested links are on 1001/1005 matching their accounts.

If the count is greater than 0, **stop and report** — the penalty would break existing matches, and this task should be dropped rather than shipped.

- [ ] **Step 2: Write the failing test**

```ts
// append to backend/src/amazon/matcher.test.ts
test('a last4 mismatch is penalised', () => {
  const order = { total: '44.97', orderDate: '2025-08-27', shipmentDate: null, paymentLast4: '2662', currency: 'CAD' } as never;
  const mismatch = scoreAmazonOrderMatch(txn, order, '1001');
  const noTxnLast4 = scoreAmazonOrderMatch(txn, order, null);
  assert.equal(mismatch.confidence < noTxnLast4.confidence, true);
  assert.match(mismatch.matchReason, /different card/);
});

test('no penalty when either side lacks a last4', () => {
  const orderNoLast4 = { total: '44.97', orderDate: '2025-08-27', shipmentDate: null, paymentLast4: null, currency: 'CAD' } as never;
  const a = scoreAmazonOrderMatch(txn, orderNoLast4, '1001');
  const b = scoreAmazonOrderMatch(txn, orderNoLast4, null);
  assert.equal(a.confidence, b.confidence, 'absence of evidence is not evidence');
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/amazon/matcher.test.ts --test-name-pattern 'mismatch|either side'`
Expected: FAIL — the mismatch scores the same as no-last4

- [ ] **Step 4: Write the implementation**

Replace the `// NOTE:` comment from Task 11 with:

```ts
    } else {
      // Two different cards is positive evidence against a match, at the same
      // magnitude as an amount mismatch. This is NOT foreign-card exclusion: it
      // is per-pair evidence, applied regardless of ownership, and it never
      // removes an order from the candidate pool.
      score -= 25;
      reasons.push('charged to a different card than the order');
    }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/amazon/matcher.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add backend/src/amazon/matcher.ts backend/src/amazon/matcher.test.ts
git commit -m "feat(amazon): penalise a last4 mismatch between txn account and order"
```

---

## Group E — Foreign-card exclusion

Behaviour, per the spec:

| state | matchable | Items page | totals | UI |
|---|---|---|---|---|
| `known` | yes | shown | counted | — |
| `unknown` | yes | shown | counted | "unverified card" badge |
| `foreign` | yes | hidden | **excluded** | "not your card" badge |

### Task 13: Exclude foreign orders from item allocations

**Files:**
- Modify: `backend/src/summary/loadItemAllocations.ts:33-42`
- Test: `backend/src/summary/loadItemAllocations.test.ts`

**Interfaces:**
- Consumes: `buildLast4Map`, `classifyCardOwnership` from Task 10.
- Produces: no signature change. `loadItemAllocationContext` silently drops foreign-card orders.

One filter here covers all nine consumers: `routes/reporting.ts`, `routes/spendByCategoryDecompose.ts`, `routes/budgets.ts`, `routes/summary.ts`, `summary/aggregateMonthly.ts`, `summary/aggregateDashboard.ts`, `budgets/budgetBreachCheck.ts`, and the `splitTxnByItems` callers.

- [ ] **Step 1: Write the failing test**

```ts
// append to backend/src/summary/loadItemAllocations.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Account, ExternalOrder, ExternalOrderItem, Transaction, TransactionOrderLink } from '../models';
import { loadItemAllocationContext } from './loadItemAllocations';

async function seed(paymentLast4: string | null) {
  await Account.create({ id: 1, name: 'Amex Reserve', owner: 'me', householdId: 1, shortCode: '701001' } as never);
  const txn = await Transaction.create({
    householdId: 1, accountId: 1, date: '2025-08-28', amount: '-44.97',
    merchantRaw: 'AMZN MKTP CA', merchantClean: 'Amazon',
  } as never);
  const order = await ExternalOrder.create({
    householdId: 1, vendor: 'amazon', vendorOrderId: '701-1111111-2222222', dedupeKey: 'k',
    orderDate: '2025-08-27', total: '44.97', currency: 'CAD', paymentLast4, source: 'amazon_report',
  } as never);
  await ExternalOrderItem.create({
    externalOrderId: order.id, title: 'Widget', quantity: 1, unitPrice: '44.97', totalPrice: '44.97',
  } as never);
  await TransactionOrderLink.create({
    transactionId: txn.id, externalOrderId: order.id,
    confidence: '90.00', matchReason: 'test', status: 'accepted',
  } as never);
  return txn;
}

test('an order on a known card is allocated', async () => {
  const txn = await seed('1001');
  const ctx = await loadItemAllocationContext([txn.id]);
  assert.equal(ctx.linksByTxn.get(txn.id)?.length, 1);
});

test('an order with no last4 is allocated — unknown is not foreign', async () => {
  const txn = await seed(null);
  const ctx = await loadItemAllocationContext([txn.id]);
  assert.equal(ctx.linksByTxn.get(txn.id)?.length, 1);
});

test('an order on a foreign card is excluded from allocation', async () => {
  const txn = await seed('2662');
  const ctx = await loadItemAllocationContext([txn.id]);
  assert.equal(ctx.linksByTxn.get(txn.id) ?? undefined, undefined);
  assert.equal(ctx.ordersById.size, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/summary/loadItemAllocations.test.ts`
Expected: FAIL — the foreign-card order is still allocated

- [ ] **Step 3: Write the implementation**

In `backend/src/summary/loadItemAllocations.ts`, add imports:

```ts
import { Account } from '../models';
import { buildLast4Map, classifyCardOwnership } from '../amazon/cardOwnership';
```

After the `orders` and `items` are fetched, and before `ordersById` is built, insert:

```ts
  // Orders paid with a card Cashflow does not track are not the household's
  // spend — 291 of 538 Amazon orders in production carry a last4 belonging to no
  // account. They stay visible and matchable elsewhere, but never reach a total.
  // `unknown` (no last4 at all, 135 orders) is deliberately NOT excluded:
  // absence of a last4 is not evidence of a foreign card.
  const householdIds = Array.from(new Set(orders.map((o) => o.householdId))).filter(
    (id): id is number => id != null,
  );
  const accounts = await Account.findAll({
    where: householdIds.length > 0 ? { householdId: { [Op.in]: householdIds } } : {},
    attributes: ['id', 'shortCode'],
  });
  const last4Map = buildLast4Map(accounts.map((a) => ({ id: a.id, shortCode: a.shortCode })));
  const ownedOrders = orders.filter(
    (o) => classifyCardOwnership(o.paymentLast4, last4Map) !== 'foreign',
  );
  const ownedOrderIds = new Set(ownedOrders.map((o) => o.id));
```

Then replace the three map-building blocks that follow:

```ts
  const linksByTxn = new Map<number, AllocatorLink[]>();
  for (const l of links) {
    if (!ownedOrderIds.has(l.externalOrderId)) continue;
    const list = linksByTxn.get(l.transactionId) ?? [];
    list.push({ externalOrderId: l.externalOrderId, linkedAmount: l.linkedAmount });
    linksByTxn.set(l.transactionId, list);
  }

  const ordersById = new Map<number, AllocatorOrder>();
  for (const o of ownedOrders) {
    ordersById.set(o.id, {
      id: o.id,
      subtotal: o.subtotal,
      tax: o.tax,
      shipping: o.shipping,
      total: o.total,
      currency: o.currency,
    });
  }

  const itemsByOrder = new Map<number, AllocatorItem[]>();
  for (const it of items) {
    if (!ownedOrderIds.has(it.externalOrderId)) continue;
    const list = itemsByOrder.get(it.externalOrderId) ?? [];
    list.push({
      id: it.id,
      totalPrice: it.totalPrice,
      unitPrice: it.unitPrice,
      // …keep the remaining AllocatorItem fields exactly as they are today
    });
    itemsByOrder.set(it.externalOrderId, list);
  }
```

A transaction whose every link pointed at a foreign order now has **no** entry in
`linksByTxn` at all, rather than an empty array — `splitTxnByItems` treats a
missing entry as "no itemization", which is the intended outcome.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/summary/loadItemAllocations.test.ts`
Expected: PASS, 3 tests

Run the consumers, since this is a chokepoint:
Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/summary/*.test.ts src/budgets/*.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/summary/loadItemAllocations.ts backend/src/summary/loadItemAllocations.test.ts
git commit -m "feat(summary): exclude foreign-card orders from item allocations

One filter at the chokepoint covers all nine consumers — reporting,
spendByCategoryDecompose, budgets, summary, aggregateMonthly,
aggregateDashboard and budgetBreachCheck."
```

---

### Task 14: Exclude foreign orders from the Items page

**Files:**
- Modify: `backend/src/routes/items.ts:430` (`GET /items`), `:266` (`/items/analyze`), `:355` (`/items/analyze/trend`)
- Test: `backend/src/routes/items.test.ts`

**Interfaces:**
- Consumes: `buildLast4Map`, `classifyCardOwnership` from Task 10.
- Produces: all three endpoints omit items whose order is foreign-card.

The Items page is **not** covered by `loadItemAllocationContext`; it queries items directly. The two analyze endpoints apply no transaction-side filter at all today.

- [ ] **Step 1: Write the failing test**

```ts
// append to backend/src/routes/items.test.ts
test('GET /items omits items from a foreign-card order', async () => {
  await seedForeignAndKnownOrders(); // helper: one order on 1001, one on 2662
  const res = await request(app).get('/api/items').set(authHeaders);
  const titles = res.body.rows.map((r: { title: string }) => r.title);
  assert.equal(titles.includes('KnownCardWidget'), true);
  assert.equal(titles.includes('ForeignCardWidget'), false);
});

test('GET /items/analyze omits foreign-card items', async () => {
  await seedForeignAndKnownOrders();
  const res = await request(app).get('/api/items/analyze').set(authHeaders);
  const titles = res.body.rows.map((r: { title: string }) => r.title);
  assert.equal(titles.includes('ForeignCardWidget'), false);
});

test('GET /items/analyze/trend omits foreign-card items', async () => {
  await seedForeignAndKnownOrders();
  const res = await request(app)
    .get('/api/items/analyze/trend?title=ForeignCardWidget')
    .set(authHeaders);
  assert.equal(res.body.points.length, 0);
});
```

Write `seedForeignAndKnownOrders` in the same file, following the existing seeding helpers there — one `Account` with `shortCode: '701001'`, one order with `paymentLast4: '1001'` holding `KnownCardWidget`, one with `paymentLast4: '2662'` holding `ForeignCardWidget`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/routes/items.test.ts --test-name-pattern 'foreign-card'`
Expected: FAIL — `ForeignCardWidget` is present in all three responses

- [ ] **Step 3: Write the implementation**

Add to `backend/src/routes/items.ts`:

```ts
import { buildLast4Map, classifyCardOwnership } from '../amazon/cardOwnership';

/**
 * Order ids whose card Cashflow does not track. The Items page queries items
 * directly and is NOT covered by loadItemAllocationContext's filter, so it needs
 * its own. `unknown` (no last4) is not excluded — see cardOwnership.ts.
 */
async function foreignOrderIds(householdId: number): Promise<number[]> {
  const [accounts, orders] = await Promise.all([
    Account.findAll({ where: { householdId }, attributes: ['id', 'shortCode'] }),
    ExternalOrder.findAll({ where: { householdId }, attributes: ['id', 'paymentLast4'] }),
  ]);
  const map = buildLast4Map(accounts.map((a) => ({ id: a.id, shortCode: a.shortCode })));
  return orders
    .filter((o) => classifyCardOwnership(o.paymentLast4, map) === 'foreign')
    .map((o) => o.id);
}
```

In each of the three handlers, resolve the ids and add to the item `where` clause:

```ts
  const excluded = await foreignOrderIds(household.id);
  if (excluded.length > 0) {
    where.externalOrderId = { [Op.notIn]: excluded };
  }
```

For `GET /items` the clause goes into `buildItemWhere`'s result at `:212`; for the two analyze endpoints it goes into their own item queries.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/routes/items.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/items.ts backend/src/routes/items.test.ts
git commit -m "feat(items): hide foreign-card order items from all three endpoints"
```

---

### Task 15: Surface `cardOwnership` in the API and badge it in the UI

**Files:**
- Modify: `shared/api-types.ts:1144` (`ExternalOrderView`), `:1277` (`ItemRow`)
- Modify: `backend/src/routes/amazon.ts:316` (`GET /review-transactions`)
- Modify: `frontend/src/pages/ItemsPage.tsx`
- Test: `frontend/src/pages/ItemsPage.test.tsx`

**Interfaces:**
- Consumes: `CardOwnership` type from Task 10.
- Produces: `ExternalOrderView.cardOwnership: 'known' | 'foreign' | 'unknown'`, derived at serialization — never stored.

- [ ] **Step 1: Extend the DTO**

In `shared/api-types.ts`, add to `ExternalOrderView`:

```ts
export type CardOwnershipView = 'known' | 'foreign' | 'unknown';

export type ExternalOrderView = {
  id: number;
  vendor: string;
  subtotal: string | null;
  tax: string | null;
  shipping: string | null;
  total: string | null;
  currency: string;
  /**
   * Whether this order was paid with a card Cashflow tracks. Derived per
   * request from accounts.short_code — never persisted. 'foreign' orders are
   * excluded from every spend total and from the Items page.
   */
  cardOwnership: CardOwnershipView;
  trip?: TripDetailView | null;
};
```

And to `ItemRow.order`:

```ts
  order: {
    id: number
    vendor: string
    cardOwnership: CardOwnershipView
  }
```

- [ ] **Step 2: Write the failing frontend test**

```tsx
// append to frontend/src/pages/ItemsPage.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

describe('ItemsPage card ownership badges', () => {
  it('badges an item whose order card is unverified', async () => {
    renderItemsPage({ rows: [itemRow({ cardOwnership: 'unknown' })] });
    expect(await screen.findByText(/unverified card/i)).toBeInTheDocument();
  });

  it('renders no badge for a known card', async () => {
    renderItemsPage({ rows: [itemRow({ cardOwnership: 'known' })] });
    expect(screen.queryByText(/unverified card/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/not your card/i)).not.toBeInTheDocument();
  });
});
```

Write `renderItemsPage` and `itemRow` following the existing helpers in that file.

- [ ] **Step 3: Run test to verify it fails**

Run: `yarn workspace frontend run test ItemsPage`
Expected: FAIL — no badge text found

- [ ] **Step 4: Serialize on the backend**

In `backend/src/routes/amazon.ts` and `backend/src/routes/items.ts`, build the last4 map once per request and set `cardOwnership: classifyCardOwnership(order.paymentLast4, map)` wherever an `ExternalOrderView` or `ItemRow.order` is constructed.

- [ ] **Step 5: Render the badge**

In `frontend/src/pages/ItemsPage.tsx`, beside the item title:

```tsx
{row.order.cardOwnership === 'unknown' && (
  <span className="ml-2 rounded px-1.5 py-0.5 text-xs bg-amber-100 text-amber-800">
    unverified card
  </span>
)}
{row.order.cardOwnership === 'foreign' && (
  <span className="ml-2 rounded px-1.5 py-0.5 text-xs bg-slate-100 text-slate-600">
    not your card
  </span>
)}
```

Use Tailwind utilities, not `App.css`. Do not restyle design-system components — build app-side components instead.

- [ ] **Step 6: Run tests to verify they pass**

Run: `yarn workspace frontend run test ItemsPage`
Expected: PASS

Run: `yarn workspace cashflow-backend run typecheck && yarn workspace frontend run lint`
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add shared/api-types.ts backend/src/routes/amazon.ts backend/src/routes/items.ts \
        frontend/src/pages/ItemsPage.tsx frontend/src/pages/ItemsPage.test.tsx
git commit -m "feat(items): surface and badge card ownership on order items"
```

---

## Group F — Scheduled ingestion

### Task 16: `gmail_receipt_scan` cron job

**Files:**
- Create: `backend/src/jobs/definitions/gmailReceiptScan.ts`
- Test: `backend/src/jobs/definitions/gmailReceiptScan.test.ts`
- Modify: `backend/src/server.ts` (after line 28)

**Interfaces:**
- Consumes: `scanInbox` from `../../integrations/scanReceipts`, `runAmazonMatching` from `../../amazon/matcher`.
- Produces: a registered job named `gmail_receipt_scan`.

Gmail scan is the only ingestion channel with no cron job, while fourteen other definitions exist. The runner already provides ticking, DB-backed config and pg advisory locking.

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/jobs/definitions/gmailReceiptScan.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import cron from 'node-cron';
import { getJobDefinition } from '../registry';
import './gmailReceiptScan';

test('the job is registered with a valid cron expression', () => {
  const def = getJobDefinition('gmail_receipt_scan');
  assert.ok(def, 'job is registered');
  assert.equal(cron.validate(def.cronDefault), true);
});

test('the job is enabled by default', () => {
  assert.equal(getJobDefinition('gmail_receipt_scan')?.enabledDefault, true);
});
```

If `getJobDefinition` is not exported from `registry.ts`, export it — `registry.test.ts` likely already needs it.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/jobs/definitions/gmailReceiptScan.test.ts`
Expected: FAIL — `Cannot find module './gmailReceiptScan'`

- [ ] **Step 3: Write the implementation**

```ts
// backend/src/jobs/definitions/gmailReceiptScan.ts
/**
 * Scheduled Gmail receipt scan.
 *
 * Gmail was the only ingestion channel reachable solely by hand — POST
 * /api/email/scan/google — while fourteen other jobs ran on cron. Receipts
 * therefore arrived only when someone remembered to click, and the Amazon order
 * corpus went stale, which is a large part of why Amazon transactions were not
 * itemized. The runner (jobs/runner.ts) supplies ticking, per-job DB-backed
 * config and pg advisory locking, so this only supplies a handler; the lock also
 * prevents overlap with a manual scan.
 */
import { defineJob } from '../registry';
import { logger } from '../../observability/logger';
import { HouseholdMember, UserEmailIntegration } from '../../models';
import { scanInbox } from '../../integrations/scanReceipts';
import { runAmazonMatching } from '../../amazon/matcher';

defineJob({
  name: 'gmail_receipt_scan',
  cronDefault: '0 5 * * *',
  enabledDefault: true,
  handler: async () => {
    // UserEmailIntegration is per-USER and carries no householdId — scanInbox
    // needs one, so resolve it through HouseholdMember the same way
    // auth/middleware.ts does.
    const integrations = await UserEmailIntegration.findAll({
      where: { provider: 'google', status: 'connected' },
    });
    let created = 0;
    let scanned = 0;
    let autoAccepted = 0;
    let errors = 0;
    const scannedHouseholds = new Set<number>();

    for (const integration of integrations) {
      try {
        const membership = await HouseholdMember.findOne({
          where: { userId: integration.userId },
        });
        if (membership == null) continue;

        const result = await scanInbox({
          userId: integration.userId,
          householdId: membership.householdId,
          maxMessages: 200,
        });
        created += result.created;
        scanned += result.results?.length ?? 0;
        scannedHouseholds.add(membership.householdId);
      } catch (err) {
        errors += 1;
        logger.error({ err, integrationId: integration.id }, 'gmail_receipt_scan_failed');
      }
    }

    // Ingest that ends without matching still leaves the user a manual step.
    // Run once per household, not once per integration — two mailboxes in one
    // household would otherwise scan the same orders twice.
    for (const householdId of scannedHouseholds) {
      try {
        const match = await runAmazonMatching({ householdId });
        autoAccepted += match.autoAccepted;
      } catch (err) {
        errors += 1;
        logger.error({ err, householdId }, 'gmail_receipt_scan_matching_failed');
      }
    }

    logger.info(
      { integrations: integrations.length, scanned, created, autoAccepted, errors },
      'gmail_receipt_scan_run',
    );
    return { summary: { integrations: integrations.length, scanned, created, autoAccepted, errors } };
  },
});
```

Confirm `UserEmailIntegration.status` uses `'connected'` for a live integration
before relying on that filter — if the values differ, drop the `status` clause
and let the per-integration `try/catch` absorb dead tokens.

- [ ] **Step 4: Register it**

In `backend/src/server.ts`, after line 28:

```ts
import './jobs/definitions/gmailReceiptScan';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/jobs/definitions/gmailReceiptScan.test.ts src/jobs/registry.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add backend/src/jobs/definitions/gmailReceiptScan.ts \
        backend/src/jobs/definitions/gmailReceiptScan.test.ts \
        backend/src/server.ts
git commit -m "feat(jobs): scan Gmail receipts on a schedule

Gmail was the only ingestion channel with no cron job while fourteen
others had one, so the Amazon order corpus went stale whenever nobody
clicked Scan. Runs matching afterwards so ingest does not end in a
manual step."
```

---

## Group G — Prime membership

### Task 17: Stop nagging about the annual Prime charge

**Files:**
- Modify: `backend/src/amazon/matcher.ts` — add `isAmazonSubscriptionCharge`, filter in `runAmazonMatching`
- Test: `backend/src/amazon/matcher.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `isAmazonSubscriptionCharge(merchant: string): boolean`.

`AMAZON.CA PRIME MEMBER` ($111.87 annual, 2 transactions) is a subscription, never an order, and can never match. Do **not** narrow `isAmazonLikeMerchant` — it is also used for the +15 merchant bonus inside `scoreAmazonOrderMatch` and is exported, so narrowing it would silently change scoring elsewhere.

- [ ] **Step 1: Write the failing test**

```ts
// append to backend/src/amazon/matcher.test.ts
import { isAmazonSubscriptionCharge, isAmazonLikeMerchant } from './matcher';

test('the annual Prime membership charge is a subscription, not an order', () => {
  assert.equal(isAmazonSubscriptionCharge('AMAZON.CA PRIME MEMBER'), true);
  assert.equal(isAmazonSubscriptionCharge('Amazon.ca Prime Member'), true);
});

test('Prime Video rentals are orders and are NOT filtered', () => {
  assert.equal(isAmazonSubscriptionCharge('AMAZON PRIME VIDEO'), false);
  assert.equal(isAmazonSubscriptionCharge('AMZN MKTP CA*Z90R91K22'), false);
});

test('isAmazonLikeMerchant is unchanged — it still matches Prime generally', () => {
  assert.equal(isAmazonLikeMerchant('AMAZON.CA PRIME MEMBER'), true);
  assert.equal(isAmazonLikeMerchant('AMAZON PRIME VIDEO'), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/amazon/matcher.test.ts --test-name-pattern 'Prime'`
Expected: FAIL — `isAmazonSubscriptionCharge` is not exported

- [ ] **Step 3: Write the implementation**

In `backend/src/amazon/matcher.ts`, beside `isAmazonLikeMerchant`:

```ts
/**
 * The annual Amazon Prime membership charge is a subscription, never an order,
 * so no external_order can ever match it and it sits in the review queue
 * forever. Deliberately narrow: Prime Video rentals ARE orders and must keep
 * matching, so this matches the membership merchant string only — and it is a
 * separate predicate from isAmazonLikeMerchant, which also drives the +15
 * merchant bonus inside scoreAmazonOrderMatch.
 */
export function isAmazonSubscriptionCharge(merchant: string): boolean {
  return /\bprime\s*member\b/i.test(merchant);
}
```

In `runAmazonMatching`, extend the existing filter:

```ts
  for (const txn of txns.filter(
    (row) =>
      isAmazonLikeMerchant(`${row.merchantRaw} ${row.merchantClean}`) &&
      !isAmazonSubscriptionCharge(`${row.merchantRaw} ${row.merchantClean}`),
  )) {
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/amazon/matcher.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/amazon/matcher.ts backend/src/amazon/matcher.test.ts
git commit -m "feat(amazon): exclude the Prime membership charge from matching"
```

---

## Final verification

- [ ] **Run everything CI runs**

Run: `yarn ci`
Expected: typecheck, all tests, both production builds pass

- [ ] **Verify against production**

Using the `cashflow-prod-db` skill, read-only, re-run the partition query from the spec and confirm:

| check | expected |
|---|---|
| Amazon transactions with an accepted link | rises from 0 toward ~54 |
| Foreign-card orders with an accepted link | **0** |
| Email-sourced Amazon orders with `order_date` | rises from 1/141 toward 141/141 after the Task 7 reprocess |
| Amazon transactions with more than one accepted link | **0** (fan-out guard) |

- [ ] **Run the one-time reprocess (Task 7)**

Collect the Gmail message ids of email-sourced Amazon orders with a null `order_date`, then call `scanInbox` with `forceReprocessMessageIds`. This is a manual operation, run once, after Tasks 1–6 have merged.

---

## Notes for the implementer

- **Do not loosen the exact-cent tolerance.** It is null-tested. ±$0.50 against undated orders is roughly half false positives.
- **Task 11 is one commit.** The tie guard and the last4 signal are a package.
- **Task 12 is gated.** Verify against production before writing code; drop the task if the verification shows existing matches would break.
- The Chrome extension has produced zero rows despite shipping (`frontend/src/extension/`, commits `c2fe34a3`, `81deae78`). Out of scope here — file an issue to find out whether it is uninstalled or the capture token was never configured.
