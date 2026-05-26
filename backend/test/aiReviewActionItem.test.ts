import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateActionItemStatus } from '../src/routes/aiReview';
import type { AiReviewActionItem } from '../src/models/AiReviewRun';

function items(): AiReviewActionItem[] {
  return [
    {
      id: 'subscription-Netflix',
      type: 'subscription',
      refType: null,
      refId: null,
      severity: 'info',
      title: 'Recurring: Netflix',
      summary: '3 charges',
      status: 'suggested',
    },
    {
      id: 'missing_receipt-42',
      type: 'missing_receipt',
      refType: 'transaction',
      refId: 42,
      severity: 'watch',
      title: 'Missing receipt',
      summary: 'Big charge',
      status: 'suggested',
    },
  ];
}

test('updateActionItemStatus flips the matched id to accepted and leaves others', () => {
  const before = items();
  const result = updateActionItemStatus(before, 'subscription-Netflix', 'accepted');
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].status, 'accepted');
  assert.equal(result.items[1].status, 'suggested');
});

test('updateActionItemStatus returns ok=false for an unknown id', () => {
  const result = updateActionItemStatus(items(), 'unknown-id', 'dismissed');
  assert.equal(result.ok, false);
});

test('updateActionItemStatus returns ok=false for an invalid status value', () => {
  const result = updateActionItemStatus(
    items(),
    'subscription-Netflix',
    'bogus' as unknown as 'accepted',
  );
  assert.equal(result.ok, false);
});

test('updateActionItemStatus returns a new array (no mutation of input)', () => {
  const before = items();
  const snapshotIds = before.map((i) => `${i.id}:${i.status}`);
  const result = updateActionItemStatus(before, 'missing_receipt-42', 'dismissed');
  assert.equal(result.ok, true);
  const afterIds = before.map((i) => `${i.id}:${i.status}`);
  assert.deepEqual(afterIds, snapshotIds, 'input array should not be mutated');
});
