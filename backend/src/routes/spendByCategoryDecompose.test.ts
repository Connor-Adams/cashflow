import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateSpendByCategoryDecomposed } from './spendByCategoryDecompose';
import type { ItemAllocationContext } from '../summary/loadItemAllocations';

// Minimal tree: ids 10 (Coffee), 20 (Books), both roots.
const tree = {
  parentById: new Map<number, number | null>([[10, null], [20, null]]),
  nameById: new Map([[10, 'Coffee'], [20, 'Books']]),
  depthById: new Map([[10, 0], [20, 0]]),
  pathById: new Map([[10, 'Coffee'], [20, 'Books']]),
} as unknown as Parameters<typeof aggregateSpendByCategoryDecomposed>[1];

const emptyCtx: ItemAllocationContext = {
  linksByTxn: new Map(), ordersById: new Map(), itemsByOrder: new Map(),
};

test('no links → identical to direct aggregation', () => {
  const rows = [
    { id: 1, amount: '-50.00', finalCategory: 'Coffee', finalCategoryId: 10, txnType: null, accountType: null },
  ];
  const r = aggregateSpendByCategoryDecomposed(rows, tree, emptyCtx, 'CAD');
  assert.equal(r.amountById.get(10), 50);
  assert.equal(r.uncat, 0);
});

// fallow-ignore-next-line complexity
test('linked mixed order splits across categories; total invariant', () => {
  const rows = [
    { id: 2, amount: '-200.00', finalCategory: 'Coffee', finalCategoryId: 10, txnType: null, accountType: null },
  ];
  const ctx: ItemAllocationContext = {
    linksByTxn: new Map([[2, [{ externalOrderId: 99, linkedAmount: null }]]]),
    ordersById: new Map([[99, { id: 99, subtotal: null, tax: null, shipping: null, total: '200.00', currency: 'CAD' }]]),
    itemsByOrder: new Map([[99, [
      { id: 1, totalPrice: '150.00', unitPrice: null, quantity: 1, inferredCategory: 'Coffee', inferredCategoryId: 10, categoryOverride: null, categoryOverrideId: null, businessUsePercent: null, businessUseOverride: null },
      { id: 2, totalPrice: '50.00', unitPrice: null, quantity: 1, inferredCategory: 'Books', inferredCategoryId: 20, categoryOverride: null, categoryOverrideId: null, businessUsePercent: null, businessUseOverride: null },
    ]]]),
  };
  const r = aggregateSpendByCategoryDecomposed(rows, tree, ctx, 'CAD');
  assert.equal(Math.round((r.amountById.get(10) ?? 0) * 100) / 100, 150);
  assert.equal(Math.round((r.amountById.get(20) ?? 0) * 100) / 100, 50);
  const total = (r.amountById.get(10) ?? 0) + (r.amountById.get(20) ?? 0) + r.uncat;
  assert.equal(Math.round(total * 100) / 100, 200); // invariant
  assert.equal(r.countById.get(10), 1);
  assert.equal(r.countById.get(20), 1); // counted once per distinct category
});
