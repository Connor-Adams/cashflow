/**
 * Unit tests for private helpers extracted from backend/src/import/runImport.ts.
 * These are intentionally narrow: no DB, no Sequelize models — pure functions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aiSuggestionToSignal,
  dedupeColdRowsByMerchantKey,
  isSequelizeUniqueLike,
} from '../src/import/runImport';

// ─── dedupeColdRowsByMerchantKey ───────────────────────────────────────────

type ColdRow = Parameters<typeof dedupeColdRowsByMerchantKey>[0][number];

function coldRow(over: Partial<ColdRow>): ColdRow {
  return {
    txnId: 0,
    signals: [],
    merchantKey: 'starbucks',
    merchantRaw: 'STARBUCKS #1234',
    merchantClean: 'STARBUCKS',
    merchantCanonical: null,
    amount: -6.5,
    date: '2026-05-01',
    currency: 'CAD',
    memory: null,
    ...over,
  };
}

test('dedupeColdRowsByMerchantKey: two rows same key, different dates → keeps later date', () => {
  const earlier = coldRow({ txnId: 1, merchantKey: 'amzn', date: '2026-04-01' });
  const later = coldRow({ txnId: 2, merchantKey: 'amzn', date: '2026-05-15' });
  const out = dedupeColdRowsByMerchantKey([earlier, later]);
  assert.equal(out.length, 1);
  assert.equal(out[0].txnId, 2);
  assert.equal(out[0].date, '2026-05-15');
});

test('dedupeColdRowsByMerchantKey: respects insertion order when only later date wins', () => {
  // Same merchantKey, later first then earlier — the earlier date must NOT
  // overwrite the later one.
  const later = coldRow({ txnId: 1, merchantKey: 'amzn', date: '2026-05-15' });
  const earlier = coldRow({ txnId: 2, merchantKey: 'amzn', date: '2026-04-01' });
  const out = dedupeColdRowsByMerchantKey([later, earlier]);
  assert.equal(out.length, 1);
  assert.equal(out[0].txnId, 1);
});

test('dedupeColdRowsByMerchantKey: empty input → []', () => {
  assert.deepEqual(dedupeColdRowsByMerchantKey([]), []);
});

test('dedupeColdRowsByMerchantKey: three distinct merchantKeys → 3 rows', () => {
  const rows = [
    coldRow({ txnId: 1, merchantKey: 'a' }),
    coldRow({ txnId: 2, merchantKey: 'b' }),
    coldRow({ txnId: 3, merchantKey: 'c' }),
  ];
  const out = dedupeColdRowsByMerchantKey(rows);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((r) => r.txnId).sort(), [1, 2, 3]);
});

// ─── aiSuggestionToSignal ──────────────────────────────────────────────────

test('aiSuggestionToSignal: pctMe=0 produces autoPctMe="0" (not null)', () => {
  const sig = aiSuggestionToSignal({
    category: 'Dining',
    business: false,
    splitType: 'me',
    pctMe: 0,
    pctPartner: 100,
    confidence: 'high',
    rationale: 'cafe',
  });
  assert.equal(sig.fields.autoPctMe, '0');
  assert.equal(sig.fields.autoPctPartner, '100');
});

test('aiSuggestionToSignal: pctMe=null produces null', () => {
  const sig = aiSuggestionToSignal({
    category: 'Dining',
    business: false,
    splitType: 'me',
    pctMe: null,
    pctPartner: null,
    confidence: 'medium',
    rationale: null,
  });
  assert.equal(sig.fields.autoPctMe, null);
  assert.equal(sig.fields.autoPctPartner, null);
});

test('aiSuggestionToSignal: returns the right shape with all required fields', () => {
  const sig = aiSuggestionToSignal({
    category: 'Subscriptions',
    business: true,
    splitType: 'shared',
    pctMe: 50,
    pctPartner: 50,
    confidence: 'high',
    rationale: 'household streaming',
  });
  assert.equal(sig.source, 'ai');
  assert.equal(sig.confidence, 'high');
  assert.equal(sig.fields.autoCategory, 'Subscriptions');
  assert.equal(sig.fields.autoBusiness, true);
  assert.equal(sig.fields.autoSplitType, 'shared');
  assert.equal(sig.fields.autoPctMe, '50');
  assert.equal(sig.fields.autoPctPartner, '50');
  assert.equal(sig.rationale, 'household streaming');
});

test('aiSuggestionToSignal: omits rationale key entirely when null', () => {
  const sig = aiSuggestionToSignal({
    category: 'Dining',
    business: false,
    splitType: 'me',
    pctMe: 100,
    pctPartner: 0,
    confidence: 'low',
    rationale: null,
  });
  assert.equal('rationale' in sig, false);
});

// ─── isSequelizeUniqueLike ─────────────────────────────────────────────────

test('isSequelizeUniqueLike: true for SequelizeUniqueConstraintError', () => {
  assert.equal(isSequelizeUniqueLike({ name: 'SequelizeUniqueConstraintError' }), true);
});

test('isSequelizeUniqueLike: true for SequelizeBulkRecordError', () => {
  assert.equal(isSequelizeUniqueLike({ name: 'SequelizeBulkRecordError' }), true);
});

test('isSequelizeUniqueLike: false for plain Error / undefined / null', () => {
  assert.equal(isSequelizeUniqueLike(new Error('boom')), false);
  assert.equal(isSequelizeUniqueLike(undefined), false);
  assert.equal(isSequelizeUniqueLike(null), false);
  assert.equal(isSequelizeUniqueLike('string'), false);
  assert.equal(isSequelizeUniqueLike(42), false);
});

test('isSequelizeUniqueLike: false for other Sequelize error names', () => {
  assert.equal(isSequelizeUniqueLike({ name: 'SequelizeValidationError' }), false);
  assert.equal(isSequelizeUniqueLike({ name: 'SequelizeDatabaseError' }), false);
  assert.equal(isSequelizeUniqueLike({ name: 'SequelizeConnectionError' }), false);
  assert.equal(isSequelizeUniqueLike({}), false);
});
