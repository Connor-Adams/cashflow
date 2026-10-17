import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectOwnerDrawIncome } from './ownerDraws';

const ASOF = '2026-09-13';

test('averages in-lookback draws over the lookback and prorates to the window', () => {
  const draws = [
    { date: '2026-07-01', amount: 4000 },
    { date: '2026-07-14', amount: 6000 },
  ];
  // 10000 / 90d = 111.11/day; x 30d window = 3333.33
  assert.equal(projectOwnerDrawIncome(draws, ASOF, 90, 30), 3333.33);
});

test('returns 0 when there are no draws', () => {
  assert.equal(projectOwnerDrawIncome([], ASOF, 90, 30), 0);
});

test('excludes draws older than the lookback', () => {
  const draws = [
    { date: '2026-07-01', amount: 4000 },
    { date: '2026-07-14', amount: 6000 },
    { date: '2026-06-04', amount: 10000 }, // 101 days back — outside a 90d lookback
  ];
  assert.equal(projectOwnerDrawIncome(draws, ASOF, 90, 30), 3333.33);
});

test('excludes draws dated after asOf', () => {
  const draws = [
    { date: '2026-07-01', amount: 4000 },
    { date: '2026-09-20', amount: 9000 }, // in the future
  ];
  assert.equal(projectOwnerDrawIncome(draws, ASOF, 90, 30), 1333.33);
});

test('ignores non-positive amounts', () => {
  const draws = [
    { date: '2026-07-01', amount: 4000 },
    { date: '2026-07-02', amount: -4000 },
    { date: '2026-07-03', amount: 0 },
  ];
  assert.equal(projectOwnerDrawIncome(draws, ASOF, 90, 30), 1333.33);
});

test('a shorter window reserves proportionally less', () => {
  const draws = [{ date: '2026-07-01', amount: 9000 }];
  // 9000/90 = 100/day; 14d window = 1400
  assert.equal(projectOwnerDrawIncome(draws, ASOF, 90, 14), 1400);
});

test('staleness decays the projection: dividing by the full lookback, not the observed span', () => {
  // Two draws 13 days apart, both ~2 months stale. Dividing by the observed
  // span would read $10,000/13d — a phantom $23k/month. Dividing by the
  // lookback lets a dead import drift toward 0 instead.
  const draws = [
    { date: '2026-07-01', amount: 4000 },
    { date: '2026-07-14', amount: 6000 },
  ];
  assert.equal(projectOwnerDrawIncome(draws, ASOF, 90, 30), 3333.33);
});

test('non-positive lookback or window clamps to 0', () => {
  const draws = [{ date: '2026-07-01', amount: 9000 }];
  assert.equal(projectOwnerDrawIncome(draws, ASOF, 0, 30), 0);
  assert.equal(projectOwnerDrawIncome(draws, ASOF, 90, 0), 0);
  assert.equal(projectOwnerDrawIncome(draws, ASOF, -90, 30), 0);
});

test('non-finite amounts are skipped rather than poisoning the total', () => {
  const draws = [
    { date: '2026-07-01', amount: 4000 },
    { date: '2026-07-02', amount: Number.NaN },
  ];
  assert.equal(projectOwnerDrawIncome(draws, ASOF, 90, 30), 1333.33);
});
