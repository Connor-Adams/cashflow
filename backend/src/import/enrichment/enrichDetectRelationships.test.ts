import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDetectRelationshipsStage, businessDaysBetween, type RelationshipCandidate } from './detectRelationshipsStage';

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

test('transfer-link via sourceReference: Fri->Mon FX pair (3 calendar / 1 business day) links with window=2', () => {
  // Weekend-spanning FX pair sharing a sourceReference. The sourceReference
  // path used CALENDAR days (3, exceeds window 2) while the amount-equality
  // path uses business days. Aligning the sourceReference path to the
  // business-day helper lets a Fri-out / Mon-in converted pair link.
  const signals = runDetectRelationshipsStage({
    txnType: 'transfer',
    merchantClean: 'Converted USD to CAD',
    amount: -5207.6,
    date: '2025-06-06', // Friday
    accountId: 1,
    householdAccountIds: [1, 2],
    refundWindowDays: 60,
    transferWindowDays: 2,
    sourceReference: 'BALANCE-WEEKEND',
    candidates: [
      candidate({
        id: 310,
        amount: 7084.89,
        date: '2025-06-09', // Monday — 3 calendar days, 1 business day
        merchantClean: 'Converted USD to CAD',
        accountId: 2,
        sourceReference: 'BALANCE-WEEKEND',
      }),
    ],
  });
  const link = signals.find((s) => s.source === 'transfer-link');
  assert.ok(link, 'Fri->Mon FX pair sharing sourceReference should link (1 business day <= window 2)');
  assert.equal(link!.fields.linkedTransactionId, 310);
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

test('refund-link: skips candidates already linked by another refund row', () => {
  // Two refunds chase the same $50 original. The first should auto-link
  // (via high-confidence refund-link); the second must not also auto-link
  // to the same row — instead it falls through to the suggested path or
  // to no signal at all. Without the alreadyLinkedByRefundId guard, both
  // refunds would point at the same original and stomp on each other.
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
    candidates: [
      candidate({
        id: 100,
        amount: -50,
        date: '2026-05-01',
        merchantClean: 'AMAZON',
        accountId: 1,
        finalCategory: 'Shopping',
        alreadyLinkedByRefundId: 999, // already claimed by an earlier refund
      }),
    ],
  });
  assert.equal(signals.filter((s) => s.source === 'refund-link').length, 0);
});

test('refund-link: prefers an unclaimed candidate over an already-linked one', () => {
  // When both options exist, the detector should skip the already-claimed
  // row and pick the free one even if the claimed row would otherwise be
  // a closer date match. This is the partial-refund-chain story: don't
  // tear an existing refund off its original just to assign a sibling
  // refund — link the sibling to whatever's still free.
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
    candidates: [
      candidate({
        id: 100,
        amount: -50,
        date: '2026-05-09', // closer
        merchantClean: 'AMAZON',
        accountId: 1,
        finalCategory: 'Shopping',
        alreadyLinkedByRefundId: 999,
      }),
      candidate({
        id: 101,
        amount: -50,
        date: '2026-05-01', // further but unclaimed
        merchantClean: 'AMAZON',
        accountId: 1,
        finalCategory: 'Shopping',
      }),
    ],
  });
  const link = signals.find((s) => s.source === 'refund-link');
  assert.ok(link);
  assert.equal(link!.fields.linkedTransactionId, 101);
});

test('refund-link: partial refund (refund amount < original) still links', () => {
  // Customer paid $200, got a $25 partial refund. Original |amount| >=
  // refund |amount| so the exact-match path still fires — explicit
  // coverage so this property doesn't regress.
  const signals = runDetectRelationshipsStage({
    txnType: 'refund',
    merchantClean: 'BEST BUY',
    amount: 25,
    date: '2026-05-10',
    accountId: 1,
    householdAccountIds: [1],
    refundWindowDays: 60,
    transferWindowDays: 2,
    sourceReference: null,
    candidates: [
      candidate({
        id: 200,
        amount: -200,
        date: '2026-05-01',
        merchantClean: 'BEST BUY',
        accountId: 1,
        finalCategory: 'Electronics',
      }),
    ],
  });
  const link = signals.find((s) => s.source === 'refund-link');
  assert.ok(link);
  assert.equal(link!.fields.linkedTransactionId, 200);
  assert.equal(link!.fields.autoCategory, 'Electronics');
});

test('refund-link-suggested: same canonical brand but different merchantClean produces medium-confidence suggestion', () => {
  // "AMZN MKTP CA*A1B2C3" purchase, "AMAZON.CA REFUND" refund — the
  // exact path can't match (merchant_clean differs), but the canonical
  // brand "Amazon" matches on both sides. The detector should emit a
  // medium-confidence suggestion so it surfaces in the review queue.
  const signals = runDetectRelationshipsStage({
    txnType: 'refund',
    merchantClean: 'AMAZON CA REFUND',
    merchantCanonical: 'Amazon',
    amount: 19.99,
    date: '2026-05-10',
    accountId: 1,
    householdAccountIds: [1],
    refundWindowDays: 60,
    transferWindowDays: 2,
    sourceReference: null,
    candidates: [
      candidate({
        id: 301,
        amount: -19.99,
        date: '2026-05-01',
        merchantClean: 'AMZN MKTP CA A1B2C3',
        merchantCanonical: 'Amazon',
        accountId: 1,
        finalCategory: 'Shopping',
      }),
    ],
  });
  const suggested = signals.find((s) => s.source === 'refund-link-suggested');
  assert.ok(suggested);
  assert.equal(suggested!.fields.linkedTransactionId, 301);
  assert.equal(suggested!.fields.autoCategory, 'Shopping');
  assert.equal(suggested!.confidence, 'medium');
  // and no high-confidence link
  assert.equal(signals.filter((s) => s.source === 'refund-link').length, 0);
});

test('refund-link-suggested: exact-match wins over canonical-match (no suggestion when exact matched)', () => {
  // If the exact-merchant path finds a candidate, the canonical-suggestion
  // path must stay quiet — otherwise we'd surface noise in the review
  // queue for already-linked refunds.
  const signals = runDetectRelationshipsStage({
    txnType: 'refund',
    merchantClean: 'AMAZON',
    merchantCanonical: 'Amazon',
    amount: 19.99,
    date: '2026-05-10',
    accountId: 1,
    householdAccountIds: [1],
    refundWindowDays: 60,
    transferWindowDays: 2,
    sourceReference: null,
    candidates: [
      candidate({
        id: 400,
        amount: -19.99,
        date: '2026-05-01',
        merchantClean: 'AMAZON',
        merchantCanonical: 'Amazon',
        accountId: 1,
        finalCategory: 'Shopping',
      }),
      candidate({
        id: 401,
        amount: -19.99,
        date: '2026-05-02',
        merchantClean: 'AMZN MKTP CA A1B2C3',
        merchantCanonical: 'Amazon',
        accountId: 1,
        finalCategory: 'Shopping',
      }),
    ],
  });
  assert.equal(signals.filter((s) => s.source === 'refund-link').length, 1);
  assert.equal(signals.filter((s) => s.source === 'refund-link-suggested').length, 0);
});

test('refund-link-suggested: nothing when no canonical brand is set', () => {
  const signals = runDetectRelationshipsStage({
    txnType: 'refund',
    merchantClean: 'OBSCURE STORE NAME',
    amount: 10,
    date: '2026-05-10',
    accountId: 1,
    householdAccountIds: [1],
    refundWindowDays: 60,
    transferWindowDays: 2,
    sourceReference: null,
    candidates: [
      candidate({
        id: 500,
        amount: -10,
        date: '2026-05-01',
        merchantClean: 'DIFFERENT NAME',
        accountId: 1,
      }),
    ],
  });
  assert.equal(signals.length, 0);
});

// --- businessDaysBetween unit tests ---

test('businessDaysBetween: same day = 0', () => {
  assert.equal(businessDaysBetween('2025-06-06', '2025-06-06'), 0);
});

test('businessDaysBetween: Thu->Fri (consecutive weekdays) = 1', () => {
  // Thu 2025-06-05 -> Fri 2025-06-06
  assert.equal(businessDaysBetween('2025-06-05', '2025-06-06'), 1);
});

test('businessDaysBetween: Fri->Mon (spanning weekend) = 1 business day', () => {
  // Fri 2025-06-06 -> Mon 2025-06-09: Sat+Sun skipped, so 1 business day
  assert.equal(businessDaysBetween('2025-06-06', '2025-06-09'), 1);
});

test('businessDaysBetween: Mon->Wed (same week) = 2', () => {
  // Mon 2025-06-02 -> Wed 2025-06-04
  assert.equal(businessDaysBetween('2025-06-02', '2025-06-04'), 2);
});

test('businessDaysBetween: Fri->Tue (spanning weekend) = 2 business days', () => {
  // Fri 2025-06-06 -> Tue 2025-06-10: Sat+Sun skipped, Mon+Tue = 2 business days
  assert.equal(businessDaysBetween('2025-06-06', '2025-06-10'), 2);
});

test('businessDaysBetween: Fri->Wed next week = 3 business days', () => {
  // Fri 2025-06-06 -> Wed 2025-06-11: Sat+Sun skipped, Mon+Tue+Wed = 3 business days
  assert.equal(businessDaysBetween('2025-06-06', '2025-06-11'), 3);
});

test('businessDaysBetween: symmetric (order of args should not matter)', () => {
  assert.equal(businessDaysBetween('2025-06-09', '2025-06-06'), businessDaysBetween('2025-06-06', '2025-06-09'));
});

// --- transfer-link weekend-aware integration tests ---

test('transfer-link: Fri->Mon (3 calendar days, 1 business day) NOW links with window=2', () => {
  // Friday 2025-06-06 out, Monday 2025-06-09 in. Calendar days = 3 (exceeds old window 2).
  // Business days = 1 (Sat/Sun skipped). With businessDaysBetween and window=2, this links.
  const signals = runDetectRelationshipsStage({
    txnType: 'transfer',
    merchantClean: 'TRANSFER OUT',
    amount: -1000,
    date: '2025-06-06',
    accountId: 1,
    householdAccountIds: [1, 2],
    refundWindowDays: 60,
    transferWindowDays: 2,
    sourceReference: null,
    candidates: [
      candidate({ id: 999, amount: 1000, date: '2025-06-09', merchantClean: 'TRANSFER IN', accountId: 2 }),
    ],
  });
  const link = signals.find((s) => s.source === 'transfer-link');
  assert.ok(link, 'Fri->Mon transfer across weekend should now link (1 business day <= window 2)');
  assert.equal(link!.fields.linkedTransactionId, 999);
});

test('transfer-link: Fri->Wed (3 business days) does NOT link with window=2', () => {
  // Friday 2025-06-06 out, Wednesday 2025-06-11 in.
  // Business days = 3 (Mon+Tue+Wed), which exceeds window=2 → must NOT link.
  const signals = runDetectRelationshipsStage({
    txnType: 'transfer',
    merchantClean: 'TRANSFER OUT',
    amount: -1000,
    date: '2025-06-06',
    accountId: 1,
    householdAccountIds: [1, 2],
    refundWindowDays: 60,
    transferWindowDays: 2,
    sourceReference: null,
    candidates: [
      candidate({ id: 888, amount: 1000, date: '2025-06-11', merchantClean: 'TRANSFER IN', accountId: 2 }),
    ],
  });
  assert.equal(signals.filter((s) => s.source === 'transfer-link').length, 0,
    'Fri->Wed (3 business days) should NOT link when window=2');
});

test('transfer-link: Mon->Wed (2 business days, same-week) still links', () => {
  // Monday 2025-06-02 -> Wednesday 2025-06-04 = 2 business days = exactly at window edge
  const signals = runDetectRelationshipsStage({
    txnType: 'transfer',
    merchantClean: 'TRANSFER OUT',
    amount: -750,
    date: '2025-06-02',
    accountId: 1,
    householdAccountIds: [1, 2],
    refundWindowDays: 60,
    transferWindowDays: 2,
    sourceReference: null,
    candidates: [
      candidate({ id: 777, amount: 750, date: '2025-06-04', merchantClean: 'TRANSFER IN', accountId: 2 }),
    ],
  });
  const link = signals.find((s) => s.source === 'transfer-link');
  assert.ok(link, 'Mon->Wed (2 business days) should still link');
  assert.equal(link!.fields.linkedTransactionId, 777);
});
