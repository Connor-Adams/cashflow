// backend/src/summary/periodInsight.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeOwedBack, type OwedBackRow } from './periodInsight';

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
