import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateDashboard,
  type SummaryTxnRow,
  type AccountRow,
} from '../src/summary/aggregateDashboard';
import type { ItemAllocationContext } from '../src/summary/loadItemAllocations';

function row(o: Partial<SummaryTxnRow>): SummaryTxnRow {
  return {
    id: 1,
    accountId: 1,
    date: '2026-05-10',
    currency: 'CAD',
    finalCategory: 'Shopping',
    finalBusiness: true,
    finalSplitType: 'me',
    merchantRaw: 'M',
    merchantClean: 'M',
    merchantCanonical: 'M',
    amount: '-100.00',
    reviewFlag: false,
    txnType: 'purchase',
    businessAmount: '0',
    ...o,
  };
}

const accounts = new Map<number, AccountRow>([
  [1, { id: 1, name: 'A', shortCode: null, accountType: 'chequing' }],
]);

// An itemContext with empty maps forces splitTxnByItems down the no-linked-items
// branch, which is the path that reads txn.businessAmount (the prod scenario:
// all business rows have signed business_amount and no order links).
const emptyCtx: ItemAllocationContext = {
  linksByTxn: new Map(),
  ordersById: new Map(),
  itemsByOrder: new Map(),
};

const biz = (out: ReturnType<typeof aggregateDashboard>, b: boolean) =>
  out.netSpendByBusiness.get(`CAD\0${b ? '1' : '0'}`) ?? null;

test('no-item business expense (signed business_amount) counts as business SPEND, not a credit', () => {
  const out = aggregateDashboard(
    [row({ amount: '-100.00', businessAmount: '-100.00' })],
    accounts,
    emptyCtx,
  );
  const b = biz(out, true);
  assert.ok(b, 'business bucket should exist');
  assert.equal(b.totalSpend, 100);
  assert.equal(b.totalCredits, 0);
  assert.equal(b.netSpend, 100);
  // personal must NOT be inflated by the flipped half
  assert.equal(biz(out, false), null);
});
