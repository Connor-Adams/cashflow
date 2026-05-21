import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDetectRelationshipsStage, type RelationshipCandidate } from '../src/import/enrichment/detectRelationshipsStage';

function candidate(overrides: Partial<RelationshipCandidate> & { id: number; amount: number; date: string; merchantClean: string }): RelationshipCandidate {
  return {
    accountId: 1,
    finalCategory: null,
    finalBusiness: false,
    ...overrides,
  };
}

test('refund-link: same merchant + opposite sign + within 60 days links to original', () => {
  const signals = runDetectRelationshipsStage({
    txnType: 'refund',
    merchantClean: 'AMAZON',
    amount: 25,
    date: '2026-05-10',
    accountId: 1,
    householdAccountIds: [1, 2],
    refundWindowDays: 60,
    transferWindowDays: 2,
    candidates: [
      candidate({ id: 100, amount: -25, date: '2026-05-01', merchantClean: 'AMAZON', accountId: 1, finalCategory: 'Shopping' }),
    ],
  });
  const link = signals.find((s) => s.source === 'refund-link');
  assert.ok(link);
  assert.equal(link!.fields.linkedTransactionId, 100);
  assert.equal(link!.fields.autoCategory, 'Shopping');
  assert.equal(link!.confidence, 'high');
});

test('refund-link: no signal when no matching original within window', () => {
  const signals = runDetectRelationshipsStage({
    txnType: 'refund',
    merchantClean: 'AMAZON',
    amount: 25,
    date: '2026-05-10',
    accountId: 1,
    householdAccountIds: [1],
    refundWindowDays: 60,
    transferWindowDays: 2,
    candidates: [],
  });
  assert.equal(signals.filter((s) => s.source === 'refund-link').length, 0);
});

test('transfer-link: opposite-sign matching amount across owned accounts within window', () => {
  const signals = runDetectRelationshipsStage({
    txnType: 'transfer',
    merchantClean: 'TRANSFER TO CHEQUING',
    amount: -500,
    date: '2026-05-10',
    accountId: 1,
    householdAccountIds: [1, 2],
    refundWindowDays: 60,
    transferWindowDays: 2,
    candidates: [
      candidate({ id: 200, amount: 500, date: '2026-05-09', merchantClean: 'TRANSFER FROM AMEX', accountId: 2 }),
    ],
  });
  const link = signals.find((s) => s.source === 'transfer-link');
  assert.ok(link);
  assert.equal(link!.fields.linkedTransactionId, 200);
  assert.equal(link!.fields.autoCategory, 'Transfer');
  assert.equal(link!.confidence, 'high');
});

test('transfer-link: skipped when candidate is on same account', () => {
  const signals = runDetectRelationshipsStage({
    txnType: 'transfer',
    merchantClean: 'TRANSFER',
    amount: -500,
    date: '2026-05-10',
    accountId: 1,
    householdAccountIds: [1, 2],
    refundWindowDays: 60,
    transferWindowDays: 2,
    candidates: [
      candidate({ id: 1, amount: 500, date: '2026-05-09', merchantClean: 'TRANSFER', accountId: 1 }),
    ],
  });
  assert.equal(signals.filter((s) => s.source === 'transfer-link').length, 0);
});

test('non-refund non-transfer types produce no signals', () => {
  const signals = runDetectRelationshipsStage({
    txnType: 'purchase',
    merchantClean: 'STARBUCKS',
    amount: -6,
    date: '2026-05-10',
    accountId: 1,
    householdAccountIds: [1],
    refundWindowDays: 60,
    transferWindowDays: 2,
    candidates: [],
  });
  assert.equal(signals.length, 0);
});
