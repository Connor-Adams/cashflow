// Task 5: field-wise parser merge. Production shows the two receipt parsers
// fill DISJOINT fields — the deterministic Amazon parser gets payment_last4 on
// 100% of orders and a total on 0%; the AI extractor gets a total on 93% and
// last4 on 0%. Win-or-fallback meant neither alone ever produced a matchable
// record. These tests lock in: AI runs only to fill gaps in an incomplete
// deterministic parse, a complete deterministic parse never calls AI, and a
// budget cap still returns the deterministic result instead of discarding it.
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

test('merges AI tenders into a deterministic result with empty tenders', async () => {
  const aiResultWithTenders: ExtractedReceiptOrder = {
    ...aiResult,
    tenders: [{ type: 'credit_card', last4: '5432', amount: 44.97 }],
  };

  const out = await parseReceiptText({
    fromAddress: 'auto-confirm@amazon.ca',
    subject: 'Your Amazon.ca order',
    text: bodyWithLast4NoTotal,
    extractFromText: async () => aiResultWithTenders,
  });

  assert.equal(out.extracted?.tenders.length, 1, 'AI tenders are merged into result');
  assert.equal(out.extracted?.tenders[0].last4, '5432');
  assert.equal(out.parser, 'amazon+ai');
  assert.equal(out.usedAi, true);
});
