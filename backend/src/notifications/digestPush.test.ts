/**
 * Unit tests for the digest web-push copy builder (issue #796, AC #6).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDigestPush } from './digestPush';
import type { WeeklyDigestData } from './digest';

function data(overrides: Partial<WeeklyDigestData>): WeeklyDigestData {
  return {
    weekStart: '2026-06-08',
    weekEnd: '2026-06-14',
    currency: 'CAD',
    totalSpend: 420,
    priorTotalSpend: 355,
    totalIncome: 0,
    priorTotalIncome: 0,
    netChange: -420,
    topCategories: [
      { category: 'Groceries', currency: 'CAD', total: 420, priorTotal: 355, delta: 65 },
    ],
    categoryDeltas: [
      { category: 'Groceries', currency: 'CAD', total: 420, priorTotal: 355, delta: 65 },
    ],
    openInsightCount: 4,
    topInsights: [],
    upcomingExpectations: [
      { id: 1, name: 'Rent', dueDate: '2026-06-21', amount: 2200, currency: 'CAD' },
    ],
    biggestTransaction: null,
    pendingCount: 0,
    budgets: [],
    hasAnyHistory: true,
    isEmptyWeek: false,
    ...overrides,
  };
}

test('buildDigestPush: title carries net change + top-category delta percent', () => {
  const push = buildDigestPush(data({}));
  // netChange -420, Groceries up 65/355 ≈ 18%.
  assert.equal(push.title, 'Your week: -420.00 CAD · Groceries up 18%');
});

test('buildDigestPush: body counts open insights + upcoming expectations', () => {
  const push = buildDigestPush(data({}));
  assert.equal(
    push.body,
    'Net -420.00 CAD this week. 4 open insights, 1 due next week. Tap to review.',
  );
});

test('buildDigestPush: positive net change gets a + sign', () => {
  const push = buildDigestPush(data({ netChange: 350, topCategories: [], categoryDeltas: [] }));
  assert.match(push.title, /^Your week: \+350\.00 CAD$/);
});

test('buildDigestPush: singular insight phrasing', () => {
  const push = buildDigestPush(data({ openInsightCount: 1, upcomingExpectations: [] }));
  assert.match(push.body, /1 open insight, 0 due next week/);
});

test('buildDigestPush: empty week → "a quiet one"', () => {
  const push = buildDigestPush(data({ isEmptyWeek: true, netChange: 0 }));
  assert.equal(push.title, 'Your week: a quiet one');
  assert.match(push.body, /Nothing spent this week/);
});
