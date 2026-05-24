import { describe, it, expect } from 'vitest';
import { splitTxnByItems, type AllocatorInput } from '../src/import/splitTxnByItems';

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

describe('splitTxnByItems', () => {
  it('returns single bucket when no links exist', () => {
    const out = splitTxnByItems(input({}));
    expect(out).toEqual([
      {
        category: 'Shopping',
        amount: -100,
        businessAmount: 0,
        currency: 'CAD',
      },
    ]);
  });

  it('allocates items by totalPrice and prorates tax', () => {
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
    expect(out).toHaveLength(2);
    const groceries = out.find((a) => a.category === 'Groceries');
    const household = out.find((a) => a.category === 'Household');
    expect(groceries?.amount).toBeCloseTo(-66.67, 1);
    expect(household?.amount).toBeCloseTo(-33.33, 1);
    expect(out.reduce((s, a) => s + a.amount, 0)).toBeCloseTo(-100, 1);
  });

  it('uses categoryOverride > inferredCategory > txn.category', () => {
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
    expect(cats.has('Household')).toBe(true);
    expect(cats.has('Snacks')).toBe(true);
    expect(cats.has('Shopping')).toBe(true);
  });

  it('scales allocations by linkedAmount for split-tender', () => {
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
    expect(out).toHaveLength(1);
    expect(out[0].amount).toBeCloseTo(-60, 1);
    expect(out[0].category).toBe('Groceries');
  });

  it('lumps drift into a txn.category bucket', () => {
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
    expect(out.reduce((s, a) => s + a.amount, 0)).toBeCloseTo(-100, 1);
    expect(out.find((a) => a.category === 'Shopping')?.amount).toBeCloseTo(-5, 1);
    expect(out.find((a) => a.category === 'Groceries')?.amount).toBeCloseTo(-95, 1);
  });

  it('applies businessUseOverride to businessAmount per allocation', () => {
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
    expect(out[0].businessAmount).toBeCloseTo(-50, 1);
  });
});
