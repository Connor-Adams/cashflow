// backend/src/summary/periodInsight.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeOwedBack, type OwedBackRow } from './periodInsight';
import { realCostOf, deltaPct } from './periodInsight';

function row(o: Partial<OwedBackRow>): OwedBackRow {
  return { id: 1, currency: 'CAD', amount: '-100.00', partnerShareAmount: null, ...o };
}

test('computeOwedBack sums partner share for shared spend', () => {
  const out = computeOwedBack(
    [row({ id: 1, amount: '-100.00', partnerShareAmount: '-40.00' })],
    new Map(),
  );
  assert.equal(out.get('CAD')?.partnerShare, 40);
  assert.equal(out.get('CAD')?.reimbursable, 0);
  assert.equal(out.get('CAD')?.owedBack, 40);
});

test('computeOwedBack sums reimbursable claims', () => {
  const out = computeOwedBack(
    [row({ id: 7, amount: '-100.00' })],
    new Map([[7, 60]]),
  );
  assert.equal(out.get('CAD')?.reimbursable, 60);
  assert.equal(out.get('CAD')?.owedBack, 60);
});

test('computeOwedBack dedups: reimbursable wins, partner share ignored on same txn', () => {
  const out = computeOwedBack(
    [row({ id: 9, amount: '-100.00', partnerShareAmount: '-40.00' })],
    new Map([[9, 70]]),
  );
  assert.equal(out.get('CAD')?.reimbursable, 70);
  assert.equal(out.get('CAD')?.partnerShare, 0);
  assert.equal(out.get('CAD')?.owedBack, 70);
});

test('computeOwedBack splits by currency', () => {
  const out = computeOwedBack(
    [
      row({ id: 1, currency: 'CAD', partnerShareAmount: '-10.00' }),
      row({ id: 2, currency: 'USD', partnerShareAmount: '-5.00' }),
    ],
    new Map(),
  );
  assert.equal(out.get('CAD')?.owedBack, 10);
  assert.equal(out.get('USD')?.owedBack, 5);
});

test('realCostOf satisfies the identity netSpend = realCost + owedBack', () => {
  assert.equal(realCostOf(10_000, 4_000), 6_000);
  assert.equal(realCostOf(10_000, 4_000) + 4_000, 10_000);
});

test('deltaPct computes percent change vs baseline', () => {
  assert.equal(deltaPct(120, 100), 20);
  assert.equal(deltaPct(80, 100), -20);
});

test('deltaPct returns null when baseline is zero', () => {
  assert.equal(deltaPct(50, 0), null);
});
