/**
 * Pure-function tests for the weekly-digest email template (issue #267).
 * Asserts the rendered subject/html/text/in-app strings include the data
 * we expect and respect the empty-week branch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatCurrency,
  formatDate,
  renderWeeklyDigest,
} from '../../src/notifications/templates/weeklyDigest';
import type { WeeklyDigestData } from '../../src/notifications/digest';

const baseData: WeeklyDigestData = {
  weekStart: '2026-05-18',
  weekEnd: '2026-05-24',
  currency: 'CAD',
  totalSpend: 350,
  priorTotalSpend: 200,
  totalIncome: 1000,
  priorTotalIncome: 1000,
  topCategories: [
    {
      category: 'Groceries',
      currency: 'CAD',
      total: 150,
      priorTotal: 100,
      delta: 50,
    },
    {
      category: 'Dining',
      currency: 'CAD',
      total: 120,
      priorTotal: 80,
      delta: 40,
    },
  ],
  biggestTransaction: {
    id: 99,
    date: '2026-05-20',
    amount: -200,
    currency: 'CAD',
    merchant: 'Big Spend Co',
    category: 'Misc',
  },
  pendingCount: 3,
  budgets: [
    {
      budgetId: 1,
      name: 'Total',
      amount: 500,
      spent: 350,
      remaining: 150,
      currency: 'CAD',
    },
  ],
  hasAnyHistory: true,
  isEmptyWeek: false,
};

test('formatCurrency: positive', () => {
  assert.equal(formatCurrency(123.4, 'CAD'), 'CAD 123.40');
});

test('formatCurrency: negative preserves sign', () => {
  assert.equal(formatCurrency(-50, 'USD'), '-USD 50.00');
});

test('formatDate: ISO YYYY-MM-DD → "Mon, May 18"', () => {
  assert.equal(formatDate('2026-05-18'), 'Mon, May 18');
});

test('renderWeeklyDigest: subject contains spend + income totals', () => {
  const r = renderWeeklyDigest(baseData);
  assert.match(r.subject, /CAD 350\.00.*CAD 1000\.00/);
});

test('renderWeeklyDigest: html includes all section headings when data present', () => {
  const r = renderWeeklyDigest(baseData);
  assert.match(r.html, /Spend &amp; income/);
  assert.match(r.html, /Top categories/);
  assert.match(r.html, /Biggest transaction/);
  assert.match(r.html, /Pending/);
  assert.match(r.html, /Budgets/);
  assert.match(r.html, /Big Spend Co/);
});

test('renderWeeklyDigest: html escapes user-supplied merchant strings', () => {
  const data: WeeklyDigestData = {
    ...baseData,
    biggestTransaction: {
      id: 99,
      date: '2026-05-20',
      amount: -200,
      currency: 'CAD',
      merchant: '<script>alert(1)</script>',
      category: null,
    },
  };
  const r = renderWeeklyDigest(data);
  assert.doesNotMatch(r.html, /<script>/);
  assert.match(r.html, /&lt;script&gt;/);
});

test('renderWeeklyDigest: text body has no HTML tags', () => {
  const r = renderWeeklyDigest(baseData);
  assert.doesNotMatch(r.text, /<\w+/);
});

test('renderWeeklyDigest: empty week → "Nothing new" branch', () => {
  const data: WeeklyDigestData = {
    ...baseData,
    isEmptyWeek: true,
    totalSpend: 0,
    totalIncome: 0,
    topCategories: [],
    biggestTransaction: null,
    pendingCount: 0,
    budgets: [],
  };
  const r = renderWeeklyDigest(data);
  assert.match(r.subject, /nothing new/i);
  assert.match(r.text, /Nothing new this week/);
  assert.match(r.html, /Nothing new this week/);
  // In-app row should NOT be created — the orchestrator owns that decision,
  // but the body string is still produced as a no-op default.
  assert.match(r.inAppBody, /Nothing new this week/);
});

test('renderWeeklyDigest: omits sections without data', () => {
  const data: WeeklyDigestData = {
    ...baseData,
    topCategories: [],
    biggestTransaction: null,
    pendingCount: 0,
    budgets: [],
  };
  const r = renderWeeklyDigest(data);
  assert.doesNotMatch(r.html, /Top categories/);
  assert.doesNotMatch(r.html, /Biggest transaction/);
  assert.doesNotMatch(r.html, /Pending/);
  // 'Budgets' heading must be omitted, but "Budget" as a word may still
  // appear in copy elsewhere — assert on the exact heading marker.
  assert.doesNotMatch(r.html, />Budgets<\/h2>/);
  // Spend & income section ALWAYS renders.
  assert.match(r.html, /Spend &amp; income/);
});

test('renderWeeklyDigest: in-app body includes top category when present', () => {
  const r = renderWeeklyDigest(baseData);
  assert.match(r.inAppBody, /Groceries/);
});
