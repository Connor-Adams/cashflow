/**
 * Unit tests for the pure money-leak detectors (Cashflow #220).
 *
 * Integration coverage (HTTP routes, DB persistence, household isolation,
 * dismissal flow) lives in test/integration/moneyLeaks.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectMoneyLeaks,
  isFeeMerchant,
  SMALL_SUBSCRIPTION_ANNUAL_MAX,
  type LeakSubscription,
  type LeakRecurringGroup,
  type LeakDeliverySpend,
} from '../src/money_leaks/detect';
import type { MoneyLeakType } from '../src/models/MoneyLeakDismissal';

function sub(overrides: Partial<LeakSubscription> = {}): LeakSubscription {
  return {
    id: 1,
    merchantName: 'Netflix',
    normalizedName: 'netflix',
    currency: 'CAD',
    amount: 15.99,
    cadence: 'monthly',
    annualizedCost: 191.88,
    status: 'active',
    priceChangeDetected: false,
    category: 'Streaming',
    lastChargeDate: '2026-05-01',
    nextExpectedDate: '2026-06-01',
    ...overrides,
  };
}

test('detectMoneyLeaks surfaces subscription_price_increase from priceChangeDetected', () => {
  const result = detectMoneyLeaks({
    subscriptions: [sub({ id: 5, priceChangeDetected: true, amount: 18.99 })],
    recurringGroups: [],
    deliverySpend: [],
    dismissals: new Set(),
  });
  const priceLeaks = result.items.filter(
    (i) => i.leakType === 'subscription_price_increase',
  );
  assert.equal(priceLeaks.length, 1);
  assert.equal(priceLeaks[0].identityKey, '5');
  assert.equal(priceLeaks[0].currency, 'CAD');
});

test('detectMoneyLeaks surfaces small_subscription when annualized < threshold', () => {
  // Two cheap subs in DIFFERENT categories: one at $3/mo ($36/yr) and one at
  // $7/mo ($84/yr) — both under the $120/yr small_subscription ceiling, and
  // they don't share a category so they don't trip duplicate_service.
  const result = detectMoneyLeaks({
    subscriptions: [
      sub({
        id: 1,
        amount: 3,
        annualizedCost: 36,
        merchantName: 'TinyCloud',
        category: 'Cloud',
      }),
      sub({
        id: 2,
        amount: 7,
        annualizedCost: 84,
        merchantName: 'MiniStream',
        category: 'News',
      }),
    ],
    recurringGroups: [],
    deliverySpend: [],
    dismissals: new Set(),
  });
  const smalls = result.items.filter((i) => i.leakType === 'small_subscription');
  assert.equal(smalls.length, 2);
  assert.equal(SMALL_SUBSCRIPTION_ANNUAL_MAX, 120);
});

test('detectMoneyLeaks skips small_subscription above threshold', () => {
  const result = detectMoneyLeaks({
    subscriptions: [
      sub({ id: 1, amount: 15.99, annualizedCost: 191.88 }), // Netflix-sized
    ],
    recurringGroups: [],
    deliverySpend: [],
    dismissals: new Set(),
  });
  const smalls = result.items.filter((i) => i.leakType === 'small_subscription');
  assert.equal(smalls.length, 0);
});

test('detectMoneyLeaks skips non-active subscriptions', () => {
  const result = detectMoneyLeaks({
    subscriptions: [
      sub({
        id: 1,
        status: 'ignored',
        amount: 5,
        annualizedCost: 60,
        priceChangeDetected: true,
      }),
      sub({
        id: 2,
        status: 'cancelled',
        amount: 5,
        annualizedCost: 60,
        priceChangeDetected: true,
      }),
    ],
    recurringGroups: [],
    deliverySpend: [],
    dismissals: new Set(),
  });
  assert.equal(result.items.length, 0);
});

test('detectMoneyLeaks deduplicates: price_increase takes priority over small_subscription', () => {
  // A cheap sub that ALSO has a price increase should appear ONCE under
  // subscription_price_increase, not twice.
  const result = detectMoneyLeaks({
    subscriptions: [
      sub({
        id: 9,
        amount: 5,
        annualizedCost: 60, // under small threshold
        priceChangeDetected: true,
      }),
    ],
    recurringGroups: [],
    deliverySpend: [],
    dismissals: new Set(),
  });
  const forThisSub = result.items.filter(
    (i) =>
      i.leakType === 'subscription_price_increase' ||
      i.leakType === 'small_subscription',
  );
  assert.equal(forThisSub.length, 1);
  assert.equal(forThisSub[0].leakType, 'subscription_price_increase');
});

test('detectMoneyLeaks emits duplicate_service for 2+ active subs in same category+currency', () => {
  const result = detectMoneyLeaks({
    subscriptions: [
      sub({
        id: 1,
        merchantName: 'Netflix',
        normalizedName: 'netflix',
        category: 'Streaming',
        amount: 15.99,
        annualizedCost: 191.88,
      }),
      sub({
        id: 2,
        merchantName: 'Disney+',
        normalizedName: 'disney+',
        category: 'Streaming',
        amount: 11.99,
        annualizedCost: 143.88,
      }),
      sub({
        id: 3,
        merchantName: 'Hulu',
        normalizedName: 'hulu',
        category: 'Streaming',
        amount: 9.99,
        annualizedCost: 119.88,
      }),
    ],
    recurringGroups: [],
    deliverySpend: [],
    dismissals: new Set(),
  });
  const dups = result.items.filter((i) => i.leakType === 'duplicate_service');
  assert.equal(dups.length, 1);
  assert.equal(dups[0].currency, 'CAD');
  assert.equal(dups[0].identityKey, 'CAD|Streaming');
  // Annual impact = total annual cost of the cluster.
  assert.equal(dups[0].annualImpact, 191.88 + 143.88 + 119.88);
});

test('detectMoneyLeaks skips duplicate_service when only one sub in category', () => {
  const result = detectMoneyLeaks({
    subscriptions: [
      sub({ id: 1, category: 'Streaming', amount: 15.99, annualizedCost: 191.88 }),
      sub({
        id: 2,
        category: 'Cloud',
        merchantName: 'AWS',
        normalizedName: 'aws',
        amount: 5,
        annualizedCost: 60,
      }),
    ],
    recurringGroups: [],
    deliverySpend: [],
    dismissals: new Set(),
  });
  const dups = result.items.filter((i) => i.leakType === 'duplicate_service');
  assert.equal(dups.length, 0);
});

test('detectMoneyLeaks separates duplicate_service by currency', () => {
  // Three streaming subs but split CAD/USD — should NOT cluster cross-currency.
  const result = detectMoneyLeaks({
    subscriptions: [
      sub({ id: 1, category: 'Streaming', currency: 'CAD' }),
      sub({ id: 2, category: 'Streaming', currency: 'USD' }),
      sub({ id: 3, category: 'Streaming', currency: 'USD' }),
    ],
    recurringGroups: [],
    deliverySpend: [],
    dismissals: new Set(),
  });
  const dups = result.items.filter((i) => i.leakType === 'duplicate_service');
  // CAD has only 1 sub (skip); USD has 2 (cluster).
  assert.equal(dups.length, 1);
  assert.equal(dups[0].currency, 'USD');
});

test('isFeeMerchant matches common fee keywords case-insensitively', () => {
  assert.equal(isFeeMerchant('ATM Fee', null), true);
  assert.equal(isFeeMerchant('Overdraft Charge', null), true);
  assert.equal(isFeeMerchant('Monthly service charge', null), true);
  assert.equal(isFeeMerchant('Interest Expense', null), true);
  assert.equal(isFeeMerchant('FOREIGN EXCHANGE FEE', null), true);
  // Category fallback.
  assert.equal(isFeeMerchant('SomeBank Auto', 'Bank Fees'), true);
  // Negative — these should NOT match.
  assert.equal(isFeeMerchant('Netflix', 'Streaming'), false);
  assert.equal(isFeeMerchant('Tim Hortons', 'Food'), false);
});

test('detectMoneyLeaks surfaces recurring_fee for fee-like recurring groups', () => {
  const groups: LeakRecurringGroup[] = [
    {
      merchant: 'Account Service Fee',
      currency: 'CAD',
      cadence: 'monthly',
      avgAmount: 4.95,
      occurrences: 6,
      category: 'Bank Fees',
      lastSeen: '2026-05-15',
    },
  ];
  const result = detectMoneyLeaks({
    subscriptions: [],
    recurringGroups: groups,
    deliverySpend: [],
    dismissals: new Set(),
  });
  const fees = result.items.filter((i) => i.leakType === 'recurring_fee');
  assert.equal(fees.length, 1);
  assert.equal(fees[0].annualImpact, 4.95 * 12);
  assert.equal(fees[0].identityKey, 'account service fee|CAD');
});

test('detectMoneyLeaks skips recurring_fee when merchant has a subscription row for same merchant+currency', () => {
  // If a subscription row already represents this charge, do not also
  // emit it as a recurring_fee leak — that would be the same issue
  // surfacing twice.
  const result = detectMoneyLeaks({
    subscriptions: [
      sub({
        merchantName: 'Account Service Fee',
        normalizedName: 'account service fee',
        currency: 'CAD',
      }),
    ],
    recurringGroups: [
      {
        merchant: 'Account Service Fee',
        currency: 'CAD',
        cadence: 'monthly',
        avgAmount: 4.95,
        occurrences: 6,
        category: 'Bank Fees',
        lastSeen: '2026-05-15',
      },
    ],
    deliverySpend: [],
    dismissals: new Set(),
  });
  const fees = result.items.filter((i) => i.leakType === 'recurring_fee');
  assert.equal(fees.length, 0);
});

test('detectMoneyLeaks emits delivery_fee_high when total delivery spend > threshold', () => {
  const result = detectMoneyLeaks({
    subscriptions: [],
    recurringGroups: [],
    deliverySpend: [
      // $200/quarter delivery fees → $800/yr annualized → over threshold
      { currency: 'CAD', total90d: 200, transactionCount: 20 },
    ],
    dismissals: new Set(),
  });
  const dlv = result.items.filter((i) => i.leakType === 'delivery_fee_high');
  assert.equal(dlv.length, 1);
  assert.equal(dlv[0].currency, 'CAD');
  assert.equal(dlv[0].identityKey, 'CAD|delivery');
});

test('detectMoneyLeaks skips delivery_fee_high when below threshold', () => {
  const result = detectMoneyLeaks({
    subscriptions: [],
    recurringGroups: [],
    deliverySpend: [{ currency: 'CAD', total90d: 5, transactionCount: 2 }],
    dismissals: new Set(),
  });
  const dlv = result.items.filter((i) => i.leakType === 'delivery_fee_high');
  assert.equal(dlv.length, 0);
});

test('detectMoneyLeaks filters out dismissed items', () => {
  const dismissals = new Set<string>();
  dismissals.add('subscription_price_increase|5');
  const result = detectMoneyLeaks({
    subscriptions: [
      sub({ id: 5, priceChangeDetected: true, amount: 18.99 }),
      sub({ id: 6, priceChangeDetected: true, amount: 22.99, normalizedName: 'spotify', merchantName: 'Spotify' }),
    ],
    recurringGroups: [],
    deliverySpend: [],
    dismissals,
  });
  const ids = result.items
    .filter((i) => i.leakType === 'subscription_price_increase')
    .map((i) => i.identityKey);
  assert.deepEqual(ids, ['6']);
});

test('detectMoneyLeaks totals roll up monthly and annual impact per currency', () => {
  // Two small subs in DIFFERENT categories — they should not cluster as a
  // duplicate_service, so each contributes its own small_subscription leak.
  const result = detectMoneyLeaks({
    subscriptions: [
      sub({ id: 1, amount: 5, annualizedCost: 60, category: 'News' }),
      sub({
        id: 2,
        amount: 8,
        annualizedCost: 96,
        merchantName: 'A',
        normalizedName: 'a',
        category: 'Cloud',
      }),
    ],
    recurringGroups: [],
    deliverySpend: [],
    dismissals: new Set(),
  });
  const cad = result.totals.byCurrency.find((c) => c.currency === 'CAD');
  assert.ok(cad);
  assert.equal(cad!.annualImpact, 60 + 96);
  assert.equal(Number(cad!.monthlyImpact.toFixed(2)), Number((156 / 12).toFixed(2)));
  assert.equal(cad!.count, 2);
});

test('detectMoneyLeaks totals exclude dismissed items', () => {
  const dismissals = new Set<string>();
  dismissals.add('small_subscription|1');
  const result = detectMoneyLeaks({
    subscriptions: [
      sub({ id: 1, amount: 5, annualizedCost: 60, category: 'News' }),
      sub({
        id: 2,
        amount: 8,
        annualizedCost: 96,
        merchantName: 'A',
        normalizedName: 'a',
        category: 'Cloud',
      }),
    ],
    recurringGroups: [],
    deliverySpend: [],
    dismissals,
  });
  const cad = result.totals.byCurrency.find((c) => c.currency === 'CAD');
  assert.ok(cad);
  // Only sub #2 ($96/yr) should be counted.
  assert.equal(cad!.annualImpact, 96);
  assert.equal(cad!.count, 1);
});

test('detectMoneyLeaks returns deterministic ordering by annualImpact desc', () => {
  const result = detectMoneyLeaks({
    subscriptions: [
      sub({ id: 1, amount: 3, annualizedCost: 36, category: 'News' }),
      sub({
        id: 2,
        amount: 8,
        annualizedCost: 96,
        merchantName: 'A',
        normalizedName: 'a',
        category: 'Cloud',
      }),
    ],
    recurringGroups: [],
    deliverySpend: [],
    dismissals: new Set(),
  });
  const annuals = result.items.map((i) => i.annualImpact);
  // Descending.
  for (let i = 1; i < annuals.length; i += 1) {
    assert.ok(annuals[i - 1] >= annuals[i]);
  }
});

test('detectMoneyLeaks emits leak rows with all required UI fields', () => {
  const result = detectMoneyLeaks({
    subscriptions: [sub({ id: 5, priceChangeDetected: true })],
    recurringGroups: [],
    deliverySpend: [],
    dismissals: new Set(),
  });
  const leak = result.items[0];
  // Required for the dashboard render:
  assert.equal(typeof leak.leakType, 'string');
  const knownTypes: MoneyLeakType[] = [
    'subscription_price_increase',
    'small_subscription',
    'recurring_fee',
    'duplicate_service',
    'delivery_fee_high',
  ];
  assert.ok(knownTypes.includes(leak.leakType));
  assert.equal(typeof leak.identityKey, 'string');
  assert.equal(typeof leak.title, 'string');
  assert.equal(typeof leak.currency, 'string');
  assert.equal(typeof leak.monthlyImpact, 'number');
  assert.equal(typeof leak.annualImpact, 'number');
  assert.equal(typeof leak.severity, 'string');
});

test('detectMoneyLeaks supports currency filter', () => {
  const result = detectMoneyLeaks({
    subscriptions: [
      sub({ id: 1, currency: 'CAD', amount: 5, annualizedCost: 60 }),
      sub({ id: 2, currency: 'USD', amount: 5, annualizedCost: 60 }),
    ],
    recurringGroups: [],
    deliverySpend: [
      { currency: 'CAD', total90d: 200, transactionCount: 20 },
      { currency: 'USD', total90d: 200, transactionCount: 20 },
    ],
    dismissals: new Set(),
    currency: 'CAD',
  });
  assert.ok(result.items.every((i) => i.currency === 'CAD'));
  assert.ok(result.totals.byCurrency.every((c) => c.currency === 'CAD'));
});
