import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitTxnByItems, type AllocatorInput } from './splitTxnByItems';

function input(overrides: Partial<AllocatorInput>): AllocatorInput {
  return {
    txn: {
      id: 1,
      amount: '-100.00',
      currency: 'CAD',
      finalCategory: 'Shopping',
      finalBusiness: false,
      finalSplitType: 'me',
      businessAmount: '0',
    },
    links: [],
    ordersById: new Map(),
    itemsByOrder: new Map(),
    ...overrides,
  };
}

test('splitTxnByItems: returns single bucket when no links exist', () => {
  const out = splitTxnByItems(input({}));
  assert.deepStrictEqual(out, [
    {
      category: 'Shopping',
      amount: -100,
      businessAmount: 0,
      currency: 'CAD',
    },
  ]);
});

test('splitTxnByItems: allocates items by totalPrice and prorates tax', () => {
  const ordersById = new Map([
    [
      10,
      {
        id: 10,
        subtotal: '90.00',
        tax: '10.00',
        shipping: null,
        total: '100.00',
        currency: 'CAD',
      },
    ],
  ]);
  const itemsByOrder = new Map([
    [
      10,
      [
        {
          id: 1,
          totalPrice: '60.00',
          unitPrice: null,
          quantity: 1,
          inferredCategory: 'Groceries',
          categoryOverride: null,
          businessUsePercent: null,
          businessUseOverride: null,
        },
        {
          id: 2,
          totalPrice: '30.00',
          unitPrice: null,
          quantity: 1,
          inferredCategory: 'Household',
          categoryOverride: null,
          businessUsePercent: null,
          businessUseOverride: null,
        },
      ],
    ],
  ]);
  const out = splitTxnByItems(
    input({
      links: [{ externalOrderId: 10, linkedAmount: null }],
      ordersById,
      itemsByOrder,
    }),
  );
  assert.equal(out.length, 2);
  const groceries = out.find((a) => a.category === 'Groceries');
  const household = out.find((a) => a.category === 'Household');
  assert.ok(Math.abs((groceries?.amount ?? 0) - -66.67) < 0.05, `got ${groceries?.amount}, want ~-66.67`);
  assert.ok(Math.abs((household?.amount ?? 0) - -33.33) < 0.05, `got ${household?.amount}, want ~-33.33`);
  assert.ok(Math.abs(out.reduce((s, a) => s + a.amount, 0) - -100) < 0.05, `sum not ~-100`);
});

test('splitTxnByItems: uses categoryOverride > inferredCategory > txn.category', () => {
  const ordersById = new Map([
    [
      10,
      {
        id: 10,
        subtotal: '50.00',
        tax: null,
        shipping: null,
        total: '50.00',
        currency: 'CAD',
      },
    ],
  ]);
  const itemsByOrder = new Map([
    [
      10,
      [
        {
          id: 1,
          totalPrice: '20.00',
          unitPrice: null,
          quantity: 1,
          inferredCategory: 'Groceries',
          categoryOverride: 'Household',
          businessUsePercent: null,
          businessUseOverride: null,
        },
        {
          id: 2,
          totalPrice: '15.00',
          unitPrice: null,
          quantity: 1,
          inferredCategory: 'Snacks',
          categoryOverride: null,
          businessUsePercent: null,
          businessUseOverride: null,
        },
        {
          id: 3,
          totalPrice: '15.00',
          unitPrice: null,
          quantity: 1,
          inferredCategory: null,
          categoryOverride: null,
          businessUsePercent: null,
          businessUseOverride: null,
        },
      ],
    ],
  ]);
  const out = splitTxnByItems(
    input({
      txn: {
        id: 1,
        amount: '-50.00',
        currency: 'CAD',
        finalCategory: 'Shopping',
        finalBusiness: false,
        finalSplitType: 'me',
        businessAmount: '0',
      },
      links: [{ externalOrderId: 10, linkedAmount: null }],
      ordersById,
      itemsByOrder,
    }),
  );
  const cats = new Set(out.map((a) => a.category));
  assert.equal(cats.has('Household'), true);
  assert.equal(cats.has('Snacks'), true);
  assert.equal(cats.has('Shopping'), true);
});

test('splitTxnByItems: scales allocations by linkedAmount for split-tender', () => {
  const ordersById = new Map([
    [
      10,
      {
        id: 10,
        subtotal: '100.00',
        tax: null,
        shipping: null,
        total: '100.00',
        currency: 'CAD',
      },
    ],
  ]);
  const itemsByOrder = new Map([
    [
      10,
      [
        {
          id: 1,
          totalPrice: '100.00',
          unitPrice: null,
          quantity: 1,
          inferredCategory: 'Groceries',
          categoryOverride: null,
          businessUsePercent: null,
          businessUseOverride: null,
        },
      ],
    ],
  ]);
  const out = splitTxnByItems(
    input({
      txn: {
        id: 1,
        amount: '-60.00',
        currency: 'CAD',
        finalCategory: 'Shopping',
        finalBusiness: false,
        finalSplitType: 'me',
        businessAmount: '0',
      },
      links: [{ externalOrderId: 10, linkedAmount: '60.00' }],
      ordersById,
      itemsByOrder,
    }),
  );
  assert.equal(out.length, 1);
  assert.ok(Math.abs(out[0].amount - -60) < 0.05, `got ${out[0].amount}, want ~-60`);
  assert.equal(out[0].category, 'Groceries');
});

test('splitTxnByItems: lumps drift into a txn.category bucket', () => {
  const ordersById = new Map([
    [
      10,
      {
        id: 10,
        subtotal: '95.00',
        tax: null,
        shipping: null,
        total: '100.00',
        currency: 'CAD',
      },
    ],
  ]);
  const itemsByOrder = new Map([
    [
      10,
      [
        {
          id: 1,
          totalPrice: '95.00',
          unitPrice: null,
          quantity: 1,
          inferredCategory: 'Groceries',
          categoryOverride: null,
          businessUsePercent: null,
          businessUseOverride: null,
        },
      ],
    ],
  ]);
  const out = splitTxnByItems(
    input({
      links: [{ externalOrderId: 10, linkedAmount: null }],
      ordersById,
      itemsByOrder,
    }),
  );
  assert.ok(Math.abs(out.reduce((s, a) => s + a.amount, 0) - -100) < 0.05, `sum not ~-100`);
  assert.ok(Math.abs((out.find((a) => a.category === 'Shopping')?.amount ?? 0) - -5) < 0.05, `drift bucket not ~-5`);
  assert.ok(Math.abs((out.find((a) => a.category === 'Groceries')?.amount ?? 0) - -95) < 0.05, `groceries not ~-95`);
});

test('splitTxnByItems: applies businessUseOverride to businessAmount per allocation', () => {
  const ordersById = new Map([
    [
      10,
      {
        id: 10,
        subtotal: '100.00',
        tax: null,
        shipping: null,
        total: '100.00',
        currency: 'CAD',
      },
    ],
  ]);
  const itemsByOrder = new Map([
    [
      10,
      [
        {
          id: 1,
          totalPrice: '100.00',
          unitPrice: null,
          quantity: 1,
          inferredCategory: 'Office',
          categoryOverride: null,
          businessUsePercent: null,
          businessUseOverride: '50.00',
        },
      ],
    ],
  ]);
  const out = splitTxnByItems(
    input({
      links: [{ externalOrderId: 10, linkedAmount: null }],
      ordersById,
      itemsByOrder,
    }),
  );
  assert.ok(Math.abs(out[0].businessAmount - -50) < 0.05, `got ${out[0].businessAmount}, want ~-50`);
});

test('splitTxnByItems: multi-item + linkedAmount split-tender allocates correctly', () => {
  const ordersById = new Map([
    [
      10,
      {
        id: 10,
        subtotal: '90.00',
        tax: '10.00',
        shipping: null,
        total: '100.00',
        currency: 'CAD',
      },
    ],
  ]);
  const itemsByOrder = new Map([
    [
      10,
      [
        {
          id: 1,
          totalPrice: '60.00',
          unitPrice: null,
          quantity: 1,
          inferredCategory: 'Groceries',
          categoryOverride: null,
          businessUsePercent: null,
          businessUseOverride: null,
        },
        {
          id: 2,
          totalPrice: '30.00',
          unitPrice: null,
          quantity: 1,
          inferredCategory: 'Household',
          categoryOverride: null,
          businessUsePercent: null,
          businessUseOverride: null,
        },
      ],
    ],
  ]);
  const out = splitTxnByItems(
    input({
      txn: {
        id: 1,
        amount: '-60.00',
        currency: 'CAD',
        finalCategory: 'Shopping',
        finalBusiness: false,
        finalSplitType: 'me',
        businessAmount: '0',
      },
      links: [{ externalOrderId: 10, linkedAmount: '60.00' }],
      ordersById,
      itemsByOrder,
    }),
  );
  // share = 60/100 = 0.6
  // Groceries: 60 * 0.6 + (10 * 0.6) * (60/90) = 36 + 4 = 40
  // Household: 30 * 0.6 + (10 * 0.6) * (30/90) = 18 + 2 = 20
  // Total = 60, no drift.
  const sum = out.reduce((s, a) => s + a.amount, 0);
  assert.ok(Math.abs(sum - (-60)) < 0.05, `sum should be -60, got ${sum}`);
  const groceries = out.find((a) => a.category === 'Groceries');
  const household = out.find((a) => a.category === 'Household');
  assert.ok(groceries != null, 'Groceries allocation present');
  assert.ok(household != null, 'Household allocation present');
  assert.ok(Math.abs(groceries!.amount - (-40)) < 0.05, `Groceries should be -40, got ${groceries!.amount}`);
  assert.ok(Math.abs(household!.amount - (-20)) < 0.05, `Household should be -20, got ${household!.amount}`);
  // Importantly: NO drift bucket under 'Shopping' since math is exact.
  const shopping = out.find((a) => a.category === 'Shopping');
  assert.equal(shopping, undefined, 'no drift bucket should be created when allocation is exact');
});
