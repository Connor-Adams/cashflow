import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  savingsRate,
  type SavingsRateTxnRow,
} from '../src/summary/savingsRate';

/**
 * Unit tests for the savings-rate aggregator (Cashflow #246).
 *
 * The aggregator is pure: it takes plain rows (already scope/currency/
 * visibility filtered by the route) plus an ordered month window, classifies
 * each row into one of five buckets — income, spending, savings, investments,
 * debtPrincipal — and computes a monthly true savings rate. Classification is
 * by the row's OWN account type + sign + txnType, which makes internal
 * transfers self-netting (the outflow leg on checking is skipped, the inflow
 * leg landing on a savings/investment/loan account is the contribution) so
 * nothing is double counted.
 */

const WINDOW = ['2026-01', '2026-02', '2026-03'];

function row(over: Partial<SavingsRateTxnRow> = {}): SavingsRateTxnRow {
  return {
    date: '2026-02-15',
    currency: 'CAD',
    amount: -100,
    txnType: 'purchase',
    transferPurpose: null,
    accountType: 'checking',
    ...over,
  };
}

// ---------------- classification ----------------

test('positive inflow on a checking account counts as income', () => {
  const res = savingsRate({
    months: WINDOW,
    transactions: [
      row({ date: '2026-02-28', amount: 5000, txnType: 'income', accountType: 'checking' }),
    ],
    currency: null,
  });
  const cad = res.byCurrency.find((c) => c.currency === 'CAD')!;
  const feb = cad.series.find((m) => m.month === '2026-02')!;
  assert.equal(feb.income, 5000);
  assert.equal(feb.spending, 0);
});

test('negative amount on a checking account counts as spending (absolute)', () => {
  const res = savingsRate({
    months: WINDOW,
    transactions: [row({ amount: -250, accountType: 'checking' })],
    currency: null,
  });
  const feb = res.byCurrency[0].series.find((m) => m.month === '2026-02')!;
  assert.equal(feb.spending, 250);
});

test('positive deposit landing on a savings account counts as savings', () => {
  const res = savingsRate({
    months: WINDOW,
    transactions: [
      row({ amount: 1000, txnType: 'transfer', accountType: 'savings' }),
    ],
    currency: null,
  });
  const feb = res.byCurrency[0].series.find((m) => m.month === '2026-02')!;
  assert.equal(feb.savings, 1000);
  // A transfer landing on savings is NOT spending and NOT income.
  assert.equal(feb.spending, 0);
  assert.equal(feb.income, 0);
});

test('positive amount on an investment account counts as investments', () => {
  const res = savingsRate({
    months: WINDOW,
    transactions: [
      row({ amount: 800, txnType: 'transfer', accountType: 'investment' }),
    ],
    currency: null,
  });
  const feb = res.byCurrency[0].series.find((m) => m.month === '2026-02')!;
  assert.equal(feb.investments, 800);
  assert.equal(feb.spending, 0);
});

test('txnType=investment or transferPurpose=investment counts as investments even off an investment account', () => {
  const byType = savingsRate({
    months: WINDOW,
    transactions: [row({ amount: 300, txnType: 'investment', accountType: 'checking' })],
    currency: null,
  });
  assert.equal(byType.byCurrency[0].series.find((m) => m.month === '2026-02')!.investments, 300);

  const byPurpose = savingsRate({
    months: WINDOW,
    transactions: [
      row({ amount: 400, txnType: 'transfer', transferPurpose: 'investment', accountType: 'checking' }),
    ],
    currency: null,
  });
  assert.equal(byPurpose.byCurrency[0].series.find((m) => m.month === '2026-02')!.investments, 400);
});

test('positive payment landing on a loan/credit_card account counts as debt principal', () => {
  for (const accountType of ['loan', 'mortgage', 'credit_card', 'credit']) {
    const res = savingsRate({
      months: WINDOW,
      transactions: [
        row({ amount: 600, txnType: 'payment', accountType }),
      ],
      currency: null,
    });
    const feb = res.byCurrency[0].series.find((m) => m.month === '2026-02')!;
    assert.equal(feb.debtPrincipal, 600, `expected debtPrincipal for ${accountType}`);
    assert.equal(feb.spending, 0, `payment to ${accountType} must not be spending`);
    assert.equal(feb.income, 0, `payment to ${accountType} must not be income`);
  }
});

test('negative spend on a credit_card account is spending, not debt principal', () => {
  // A purchase on a credit card is consumption; only the positive payment that
  // pays the card down is principal.
  const res = savingsRate({
    months: WINDOW,
    transactions: [row({ amount: -120, txnType: 'purchase', accountType: 'credit_card' })],
    currency: null,
  });
  const feb = res.byCurrency[0].series.find((m) => m.month === '2026-02')!;
  assert.equal(feb.spending, 120);
  assert.equal(feb.debtPrincipal, 0);
});

// ---------------- no double counting ----------------

test('an internal transfer checking->savings is not double counted', () => {
  const res = savingsRate({
    months: WINDOW,
    transactions: [
      // outflow leg on checking — must be skipped (not spending)
      row({ amount: -1000, txnType: 'transfer', accountType: 'checking' }),
      // inflow leg on savings — the savings contribution
      row({ amount: 1000, txnType: 'transfer', accountType: 'savings' }),
      // genuine income so the rate is computable
      row({ amount: 4000, txnType: 'income', accountType: 'checking' }),
    ],
    currency: null,
  });
  const feb = res.byCurrency[0].series.find((m) => m.month === '2026-02')!;
  assert.equal(feb.spending, 0, 'transfer-out leg must not be counted as spending');
  assert.equal(feb.savings, 1000);
  assert.equal(feb.income, 4000);
});

// ---------------- formula + toggles ----------------

test('savingsRatePct = (savings + investments + debtPrincipal) / income by default', () => {
  const res = savingsRate({
    months: WINDOW,
    transactions: [
      row({ amount: 10000, txnType: 'income', accountType: 'checking' }),
      row({ amount: 1000, txnType: 'transfer', accountType: 'savings' }),
      row({ amount: 500, txnType: 'transfer', accountType: 'investment' }),
      row({ amount: 500, txnType: 'payment', accountType: 'loan' }),
    ],
    currency: null,
  });
  const feb = res.byCurrency[0].series.find((m) => m.month === '2026-02')!;
  // (1000 + 500 + 500) / 10000 = 20%
  assert.equal(feb.savingsRatePct, 20);
});

test('includeInvestments=false drops investments from the numerator', () => {
  const res = savingsRate({
    months: WINDOW,
    transactions: [
      row({ amount: 10000, txnType: 'income', accountType: 'checking' }),
      row({ amount: 1000, txnType: 'transfer', accountType: 'savings' }),
      row({ amount: 500, txnType: 'transfer', accountType: 'investment' }),
      row({ amount: 500, txnType: 'payment', accountType: 'loan' }),
    ],
    currency: null,
    includeInvestments: false,
  });
  const feb = res.byCurrency[0].series.find((m) => m.month === '2026-02')!;
  // (1000 + 500) / 10000 = 15%; investments still reported as a component.
  assert.equal(feb.savingsRatePct, 15);
  assert.equal(feb.investments, 500);
});

test('includeDebtPrincipal=false drops debt principal from the numerator', () => {
  const res = savingsRate({
    months: WINDOW,
    transactions: [
      row({ amount: 10000, txnType: 'income', accountType: 'checking' }),
      row({ amount: 1000, txnType: 'transfer', accountType: 'savings' }),
      row({ amount: 500, txnType: 'transfer', accountType: 'investment' }),
      row({ amount: 500, txnType: 'payment', accountType: 'loan' }),
    ],
    currency: null,
    includeDebtPrincipal: false,
  });
  const feb = res.byCurrency[0].series.find((m) => m.month === '2026-02')!;
  // (1000 + 500) / 10000 = 15%
  assert.equal(feb.savingsRatePct, 15);
  assert.equal(feb.debtPrincipal, 500);
});

test('savingsRatePct is null for a month with no income (avoids divide by zero)', () => {
  const res = savingsRate({
    months: WINDOW,
    transactions: [row({ amount: 1000, txnType: 'transfer', accountType: 'savings' })],
    currency: null,
  });
  const feb = res.byCurrency[0].series.find((m) => m.month === '2026-02')!;
  assert.equal(feb.income, 0);
  assert.equal(feb.savings, 1000);
  assert.equal(feb.savingsRatePct, null);
});

test('result echoes the include flags it was computed with', () => {
  const res = savingsRate({
    months: WINDOW,
    transactions: [],
    currency: null,
    includeInvestments: false,
    includeDebtPrincipal: true,
  });
  assert.equal(res.includeInvestments, false);
  assert.equal(res.includeDebtPrincipal, true);
  assert.deepEqual(res.windowMonths, WINDOW);
});

// ---------------- currency + window ----------------

test('groups by currency and respects a currency filter', () => {
  const txns = [
    row({ amount: 5000, txnType: 'income', accountType: 'checking', currency: 'CAD' }),
    row({ amount: 500, txnType: 'transfer', accountType: 'savings', currency: 'CAD' }),
    row({ amount: 3000, txnType: 'income', accountType: 'checking', currency: 'USD' }),
    row({ amount: 300, txnType: 'transfer', accountType: 'savings', currency: 'USD' }),
  ];
  const all = savingsRate({ months: WINDOW, transactions: txns, currency: null });
  assert.equal(all.byCurrency.length, 2);
  assert.deepEqual(
    all.byCurrency.map((c) => c.currency),
    ['CAD', 'USD'],
  );

  const cadOnly = savingsRate({ months: WINDOW, transactions: txns, currency: 'CAD' });
  assert.equal(cadOnly.byCurrency.length, 1);
  assert.equal(cadOnly.byCurrency[0].currency, 'CAD');
});

test('window totals + average savings rate are computed across the window', () => {
  const res = savingsRate({
    months: WINDOW,
    transactions: [
      // Jan: income 1000, savings 100 -> 10%
      row({ date: '2026-01-28', amount: 1000, txnType: 'income', accountType: 'checking' }),
      row({ date: '2026-01-15', amount: 100, txnType: 'transfer', accountType: 'savings' }),
      // Mar: income 1000, savings 300 -> 30%
      row({ date: '2026-03-28', amount: 1000, txnType: 'income', accountType: 'checking' }),
      row({ date: '2026-03-15', amount: 300, txnType: 'transfer', accountType: 'savings' }),
    ],
    currency: null,
  });
  const cad = res.byCurrency[0];
  assert.equal(cad.totals.income, 2000);
  assert.equal(cad.totals.savings, 400);
  // Window savings rate is on the totals: 400 / 2000 = 20%.
  assert.equal(cad.totals.savingsRatePct, 20);
  // Months with no data are zero-filled, never dropped.
  assert.equal(cad.series.length, 3);
  assert.equal(cad.series.find((m) => m.month === '2026-02')!.income, 0);
});

test('rows outside the window are ignored', () => {
  const res = savingsRate({
    months: WINDOW,
    transactions: [
      row({ date: '2025-12-15', amount: 9999, txnType: 'income', accountType: 'checking' }),
    ],
    currency: null,
  });
  assert.equal(res.byCurrency.length, 0);
});
