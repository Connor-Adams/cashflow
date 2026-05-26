import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDetectRelationshipsStage, type RelationshipCandidate } from '../src/import/enrichment/detectRelationshipsStage';

function candidate(overrides: Partial<RelationshipCandidate> & { id: number; amount: number; date: string; merchantClean: string }): RelationshipCandidate {
  return {
    accountId: 1,
    finalCategory: null,
    finalBusiness: false,
    sourceReference: null,
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
    sourceReference: null,
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
    sourceReference: null,
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
    sourceReference: null,
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
    sourceReference: null,
    candidates: [
      candidate({ id: 1, amount: 500, date: '2026-05-09', merchantClean: 'TRANSFER', accountId: 1 }),
    ],
  });
  assert.equal(signals.filter((s) => s.source === 'transfer-link').length, 0);
});

test('transfer-link via sourceReference: cross-currency FX pair links even with different amounts', () => {
  // Wise Converted row: USD outflow -5,207.60 on account 1, CAD inflow +7,084.89
  // on account 2, both stamped sourceReference="BALANCE-5207451832". Equal-amount
  // path can never match these; sourceReference path does.
  const signals = runDetectRelationshipsStage({
    txnType: 'transfer',
    merchantClean: 'Converted 5,207.60 USD to 7,084.89 CAD',
    amount: -5207.60,
    date: '2026-04-30',
    accountId: 1,
    householdAccountIds: [1, 2],
    refundWindowDays: 60,
    transferWindowDays: 2,
    sourceReference: 'BALANCE-5207451832',
    candidates: [
      candidate({
        id: 300,
        amount: 7084.89,
        date: '2026-04-30',
        merchantClean: 'Converted 5,207.60 USD to 7,084.89 CAD',
        accountId: 2,
        sourceReference: 'BALANCE-5207451832',
      }),
    ],
  });
  const link = signals.find((s) => s.source === 'transfer-link');
  assert.ok(link);
  assert.equal(link!.fields.linkedTransactionId, 300);
  assert.equal(link!.fields.autoCategory, 'Transfer');
});

test('transfer-link via sourceReference: ignores candidate with non-matching sourceReference', () => {
  const signals = runDetectRelationshipsStage({
    txnType: 'transfer',
    merchantClean: 'Converted X USD to Y CAD',
    amount: -5207.60,
    date: '2026-04-30',
    accountId: 1,
    householdAccountIds: [1, 2],
    refundWindowDays: 60,
    transferWindowDays: 2,
    sourceReference: 'BALANCE-1',
    candidates: [
      candidate({
        id: 301,
        amount: 7084.89,
        date: '2026-04-30',
        merchantClean: 'Converted X USD to Y CAD',
        accountId: 2,
        sourceReference: 'BALANCE-2',
      }),
    ],
  });
  assert.equal(signals.filter((s) => s.source === 'transfer-link').length, 0);
});

test('transfer-link via sourceReference: ignores candidate on same account', () => {
  const signals = runDetectRelationshipsStage({
    txnType: 'transfer',
    merchantClean: 'X',
    amount: -100,
    date: '2026-04-30',
    accountId: 1,
    householdAccountIds: [1, 2],
    refundWindowDays: 60,
    transferWindowDays: 2,
    sourceReference: 'REF-1',
    candidates: [
      candidate({ id: 1, amount: 100, date: '2026-04-30', merchantClean: 'X', accountId: 1, sourceReference: 'REF-1' }),
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
    sourceReference: null,
    candidates: [],
  });
  assert.equal(signals.length, 0);
});
