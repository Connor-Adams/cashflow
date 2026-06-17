import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitTxnByItems } from './splitTxnByItems';

const txn = {
  id: 1, amount: '-100', currency: 'CAD',
  finalCategory: 'Shopping', finalCategoryId: 7,
  finalBusiness: false, finalSplitType: 'me', businessAmount: '0',
};

test('no items → single allocation carries txn finalCategoryId', () => {
  const out = splitTxnByItems({ txn, links: [], ordersById: new Map(), itemsByOrder: new Map() });
  assert.equal(out.length, 1);
  assert.equal(out[0].categoryId, 7);
  assert.equal(out[0].category, 'Shopping');
});

test('item override id wins over inferred id wins over txn id', () => {
  const ordersById = new Map([[10, { id: 10, subtotal: '100', tax: '0', shipping: '0', total: '100', currency: 'CAD' }]]);
  const itemsByOrder = new Map([[10, [
    { id: 1, externalOrderId: 10, title: 'A', totalPrice: '60', unitPrice: null, quantity: 1, inferredCategory: 'Food', inferredCategoryId: 3, categoryOverride: 'Treats', categoryOverrideId: 5, businessUsePercent: null, businessUseOverride: null },
    { id: 2, externalOrderId: 10, title: 'B', totalPrice: '40', unitPrice: null, quantity: 1, inferredCategory: 'Books', inferredCategoryId: 8, categoryOverride: null, categoryOverrideId: null, businessUsePercent: null, businessUseOverride: null },
  ]]]);
  const links = [{ externalOrderId: 10, linkedAmount: '-100' }];
  const out = splitTxnByItems({ txn, links, ordersById, itemsByOrder });
  const byCat = new Map(out.map((a) => [a.categoryId, a]));
  assert.ok(byCat.has(5)); // override id
  assert.ok(byCat.has(8)); // inferred id (no override)
});
