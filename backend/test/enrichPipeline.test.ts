import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enrichTransaction, type EnrichInputs } from '../src/import/enrich';
import type { RuleRow } from '../src/import/applyRules';

function rule(o: Partial<RuleRow> & { id: number; merchantPattern: string }): RuleRow {
  return { priority: 1, matchKind: 'substring', category: null, isBusiness: false, splitType: 'me', pctMe: null, pctPartner: null, ...o } as RuleRow;
}

function baseInputs(overrides: Partial<EnrichInputs>): EnrichInputs {
  return {
    raw: { merchantRaw: 'STARBUCKS #123', date: '2026-05-10', amount: -6.5, sourceReference: null, notes: null },
    accountId: 1,
    householdId: null,
    householdAccountIds: [1],
    rules: [],
    amazonOrders: [],
    memory: null,
    recurringHistory: [],
    relationshipCandidates: [],
    refundWindowDays: 60,
    transferWindowDays: 2,
    recurringMinSupport: 3,
    amazonLinkThreshold: 70,
    ...overrides,
  };
}

test('pipeline applies normalize + detect-type for an unmatched merchant', async () => {
  const result = await enrichTransaction(baseInputs({}));
  assert.equal(result.fields.merchantClean, 'STARBUCKS');
  assert.equal(result.fields.txnType, 'purchase');
  assert.equal(result.fields.autoCategory, null);
  assert.equal(result.fields.reviewFlag, true);
});

test('pipeline applies rule and clears review flag', async () => {
  const result = await enrichTransaction(baseInputs({
    rules: [rule({ id: 1, merchantPattern: 'STARBUCKS', category: 'Dining' })],
  }));
  assert.equal(result.fields.autoCategory, 'Dining');
  assert.equal(result.fields.autoSource, 'rule');
  assert.equal(result.fields.reviewFlag, false);
});

test('pipeline applies merchant-memory when no rule matches', async () => {
  const result = await enrichTransaction(baseInputs({
    memory: {
      merchantClean: 'STARBUCKS',
      category: 'Dining',
      business: false,
      splitType: 'me',
      pctMe: null,
      pctPartner: null,
      supportCount: 3,
      exampleTransactionIds: [1, 2, 3],
      matchedByAmount: true,
    },
  }));
  assert.equal(result.fields.autoCategory, 'Dining');
  assert.equal(result.fields.autoSource, 'memory');
  assert.equal(result.fields.reviewFlag, false);
});

test('pipeline marks recurring with monthly history', async () => {
  const result = await enrichTransaction(baseInputs({
    raw: { merchantRaw: 'NETFLIX.COM', date: '2026-05-10', amount: -14.99, sourceReference: null, notes: null },
    recurringHistory: [
      { date: '2026-02-10', amount: -14.99, finalCategory: 'Subscriptions' },
      { date: '2026-03-10', amount: -14.99, finalCategory: 'Subscriptions' },
      { date: '2026-04-10', amount: -14.99, finalCategory: 'Subscriptions' },
    ],
  }));
  assert.equal(result.fields.isRecurring, true);
  assert.equal(result.fields.merchantCanonical, 'Netflix');
});

test('pipeline links refund to original within window', async () => {
  const result = await enrichTransaction(baseInputs({
    raw: { merchantRaw: 'AMAZON.COM REFUND', date: '2026-05-10', amount: 25, sourceReference: null, notes: null },
    relationshipCandidates: [
      { id: 99, accountId: 1, amount: -25, date: '2026-05-01', merchantClean: 'AMAZON.COM REFUND', finalCategory: 'Shopping', finalBusiness: false },
    ],
  }));
  assert.equal(result.fields.linkedTransactionId, 99);
  assert.equal(result.fields.autoCategory, 'Shopping');
});

test('pipeline applies amazon items signal when order matches', async () => {
  const result = await enrichTransaction(baseInputs({
    raw: { merchantRaw: 'AMZN MKTP US*ABC', date: '2026-05-10', amount: -50, sourceReference: null, notes: null },
    amazonOrders: [
      {
        id: 42,
        vendor: 'amazon',
        total: 50,
        orderDate: '2026-05-09',
        shipmentDate: null,
        paymentLast4: null,
        items: [{ id: 1, title: 'USB Cable', totalPrice: '50', inferredCategory: 'Office', businessUsePercent: '0' }],
      },
    ],
  }));
  assert.equal(result.fields.merchantCanonical, 'Amazon');
  // item-link is non-AI; should clear review when category is unanimous.
  assert.equal(result.fields.autoCategory, 'Office');
  assert.equal(result.fields.reviewFlag, false);
});

test('pipeline returns all stage signals in result', async () => {
  const result = await enrichTransaction(baseInputs({
    rules: [rule({ id: 1, merchantPattern: 'STARBUCKS', category: 'Dining' })],
  }));
  const sources = result.signals.map((s) => s.source);
  assert.ok(sources.includes('normalize-seed'));
  assert.ok(sources.includes('type-detect'));
  assert.ok(sources.includes('rule'));
});

test('enrichTransaction labels WS investment txn via ws-investment stage', async () => {
  const result = await enrichTransaction({
    raw: {
      merchantRaw: 'XEQT - iShares Core Equity ETF Portfolio: Bought 0.3921 shares at $40.78 per share (executed at 2026-01-06)',
      amount: 0,
      date: '2026-01-06',
      notes: null,
      sourceReference: null,
    },
    rules: [],
    memory: null,
    recurringHistory: [],
    amazonOrders: [],
    relationshipCandidates: [],
    accountId: 1,
    householdAccountIds: [1],
  } as any);

  assert.equal(result.fields.merchantCanonical, 'XEQT — Buy');
});

test('enrichTransaction labels regular merchant via normalize-seed (not WS stage)', async () => {
  const result = await enrichTransaction({
    raw: {
      merchantRaw: 'STARBUCKS 04747 GUELPH',
      amount: 5.25,
      date: '2026-01-06',
      notes: null,
      sourceReference: null,
    },
    rules: [],
    memory: null,
    recurringHistory: [],
    amazonOrders: [],
    relationshipCandidates: [],
    accountId: 1,
    householdAccountIds: [1],
  } as any);

  assert.equal(result.fields.merchantCanonical, 'Starbucks');
});
