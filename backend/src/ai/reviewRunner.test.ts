import test from 'node:test';
import assert from 'node:assert/strict';
import { insightItemToReviewItem } from './reviewRunner';
import type { CfoBriefingActionItem } from '../models/CfoBriefing';

/** Minimal valid CfoBriefingActionItem, overridable per test. */
function makeItem(overrides: Partial<CfoBriefingActionItem> = {}): CfoBriefingActionItem {
  return {
    id: 'insight-1',
    type: 'anomaly',
    refType: 'transaction',
    refId: 900,
    severity: 'watch',
    title: 'Possible duplicate charge from Loblaws',
    summary: '2 charges of $50.00 at Loblaws within 3 days.',
    status: 'open',
    supportingTransactionIds: [900, 901],
    rationale: 'Detected by the duplicate_transactions insight detector.',
    ...overrides,
  };
}

test('status remap: open -> suggested, resolved -> accepted, dismissed -> dismissed', () => {
  assert.equal(insightItemToReviewItem(makeItem({ status: 'open' })).status, 'suggested');
  assert.equal(insightItemToReviewItem(makeItem({ status: 'resolved' })).status, 'accepted');
  assert.equal(insightItemToReviewItem(makeItem({ status: 'dismissed' })).status, 'dismissed');
});

test('refType passes through for each review-vocabulary value', () => {
  assert.equal(insightItemToReviewItem(makeItem({ refType: 'transaction', refId: 1 })).refType, 'transaction');
  assert.equal(insightItemToReviewItem(makeItem({ refType: 'event', refId: 2 })).refType, 'event');
  assert.equal(insightItemToReviewItem(makeItem({ refType: 'rule', refId: 3 })).refType, 'rule');
});

test('refType falls back to null (and refId is forced null) for CFO-only ref types', () => {
  const subscriptionItem = insightItemToReviewItem(
    makeItem({ refType: 'subscription', refId: 42 }),
  );
  assert.equal(subscriptionItem.refType, null);
  assert.equal(subscriptionItem.refId, null);

  const importItem = insightItemToReviewItem(makeItem({ refType: 'import', refId: 7 }));
  assert.equal(importItem.refType, null);
  assert.equal(importItem.refId, null);
});

test('type passes through for a value shared by both vocabularies', () => {
  const item = insightItemToReviewItem(makeItem({ type: 'anomaly' }));
  assert.equal(item.type, 'anomaly');
});

test('type falls back to other for a CFO-exclusive type', () => {
  const item = insightItemToReviewItem(makeItem({ type: 'safe_to_spend_low' }));
  assert.equal(item.type, 'other');
});

test('direct-copy fields survive unchanged', () => {
  const item = insightItemToReviewItem(
    makeItem({
      severity: 'action',
      title: 'Cash runway is short',
      summary: 'You have 4 days of runway left.',
      supportingTransactionIds: [11, 22, 33],
      rationale: 'Detected by the cash_runway_low insight detector.',
    }),
  );
  assert.equal(item.severity, 'action');
  assert.equal(item.title, 'Cash runway is short');
  assert.equal(item.summary, 'You have 4 days of runway left.');
  assert.deepEqual(item.supportingTransactionIds, [11, 22, 33]);
  assert.equal(item.rationale, 'Detected by the cash_runway_low insight detector.');
});
