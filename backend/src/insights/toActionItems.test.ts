import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mapInsightSeverity,
  supportingIdsFromMetadata,
  insightToActionItem,
} from './toActionItems';

test('severity mapping is total over the Insight severities', () => {
  assert.equal(mapInsightSeverity('info'), 'info');
  assert.equal(mapInsightSeverity('warning'), 'watch');
  assert.equal(mapInsightSeverity('critical'), 'action');
});

test('supporting ids come from metadata.transactionIds when present', () => {
  assert.deepEqual(supportingIdsFromMetadata({ transactionIds: [3, 1, 2] }), [3, 1, 2]);
  assert.deepEqual(supportingIdsFromMetadata({ transactionIds: [1, 'x', 2] }), [1, 2]);
  assert.deepEqual(supportingIdsFromMetadata(null), []);
  assert.deepEqual(supportingIdsFromMetadata({}), []);
  assert.deepEqual(supportingIdsFromMetadata('nope'), []);
});

test('maps an insight row into a briefing action item', () => {
  const item = insightToActionItem({
    id: 42,
    type: 'duplicate_transactions',
    severity: 'warning',
    title: 'Possible duplicate charge from Loblaws',
    description: '2 charges of $50.00 at Loblaws within 3 days.',
    entityType: 'transaction',
    entityId: 900,
    metadata: { transactionIds: [900, 901] },
  });

  assert.equal(item.id, 'insight-42');
  assert.equal(item.type, 'anomaly');
  assert.equal(item.severity, 'watch');
  assert.equal(item.title, 'Possible duplicate charge from Loblaws');
  assert.equal(item.summary, '2 charges of $50.00 at Loblaws within 3 days.');
  assert.equal(item.status, 'open');
  assert.equal(item.refType, 'transaction');
  assert.equal(item.refId, 900);
  assert.deepEqual(item.supportingTransactionIds, [900, 901]);
  assert.equal(item.link, '/insights');
});

test('falls back to the title when an insight has no description', () => {
  const item = insightToActionItem({
    id: 7,
    type: 'cash_runway_low',
    severity: 'critical',
    title: 'Cash runway is short',
    description: null,
    entityType: null,
    entityId: null,
    metadata: null,
  });

  assert.equal(item.summary, 'Cash runway is short');
  assert.equal(item.severity, 'action');
  assert.equal(item.refType, null);
  assert.equal(item.refId, null);
  assert.deepEqual(item.supportingTransactionIds, []);
});

test('an unrecognised entityType does not become an invalid refType', () => {
  const item = insightToActionItem({
    id: 8,
    type: 'settlement_imbalance',
    severity: 'info',
    title: 'Settlement imbalance',
    description: 'You are owed $120.',
    entityType: 'contact',
    entityId: 5,
    metadata: null,
  });

  assert.equal(item.refType, null);
  assert.equal(item.refId, null);
});
