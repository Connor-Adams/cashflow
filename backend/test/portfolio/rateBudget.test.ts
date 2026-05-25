import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RateBudget } from '../../src/portfolio/rateBudget';

test('RateBudget spends from a daily cap and refuses when exhausted', () => {
  const budget = new RateBudget({ dailyCap: 3, now: () => new Date('2026-05-24T10:00:00Z') });
  assert.equal(budget.spend(), true);
  assert.equal(budget.spend(), true);
  assert.equal(budget.spend(), true);
  assert.equal(budget.spend(), false, '4th call exceeds cap');
  assert.equal(budget.remaining(), 0);
});

test('RateBudget resets at next UTC midnight', () => {
  let nowDate = new Date('2026-05-24T23:00:00Z');
  const budget = new RateBudget({ dailyCap: 2, now: () => nowDate });
  budget.spend();
  budget.spend();
  assert.equal(budget.spend(), false);

  nowDate = new Date('2026-05-25T00:00:01Z');
  assert.equal(budget.spend(), true, 'budget rolls over after UTC midnight');
  assert.equal(budget.remaining(), 1);
});

test('RateBudget.nextResetAt returns next UTC midnight', () => {
  const now = new Date('2026-05-24T15:00:00Z');
  const budget = new RateBudget({ dailyCap: 1, now: () => now });
  assert.equal(budget.nextResetAt().toISOString(), '2026-05-25T00:00:00.000Z');
});
