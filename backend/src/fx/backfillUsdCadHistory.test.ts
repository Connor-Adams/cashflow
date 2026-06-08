import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../db';
import { FxRate } from '../models';
import { backfillUsdCadHistory } from './backfillUsdCadHistory';

beforeEach(async () => {
  await sequelize.sync({ force: true });
});

test('inserts rows for each observation returned from a stub fetcher', async () => {
  const stubFetcher = async (_start: string, _end: string) => ({
    observations: [
      { d: '2024-01-02', FXUSDCAD: { v: '1.3300' } },
      { d: '2024-01-03', FXUSDCAD: { v: '1.3320' } },
      { d: '2024-01-04', FXUSDCAD: { v: '1.3315' } },
    ],
  });

  const inserted = await backfillUsdCadHistory({
    startDate: '2024-01-01',
    endDate: '2024-01-05',
    fetcher: stubFetcher,
  });

  assert.equal(inserted, 3);
  const rows = await FxRate.findAll({
    where: { fromCurrency: 'USD', toCurrency: 'CAD' },
    order: [['ratedDate', 'ASC']],
  });
  assert.equal(rows.length, 3);
  assert.equal(rows[0].ratedDate, '2024-01-02');
  assert.equal(Number(rows[0].rate), 1.33);
});

test('is idempotent: a second run inserts zero new rows', async () => {
  const stubFetcher = async (_start: string, _end: string) => ({
    observations: [{ d: '2024-01-02', FXUSDCAD: { v: '1.3300' } }],
  });

  const first = await backfillUsdCadHistory({
    startDate: '2024-01-01',
    endDate: '2024-01-05',
    fetcher: stubFetcher,
  });
  assert.equal(first, 1);

  const second = await backfillUsdCadHistory({
    startDate: '2024-01-01',
    endDate: '2024-01-05',
    fetcher: stubFetcher,
  });
  assert.equal(second, 0);

  const rows = await FxRate.findAll();
  assert.equal(rows.length, 1);
});

test('skips observations that already exist (partial overlap)', async () => {
  await FxRate.create({
    fromCurrency: 'USD',
    toCurrency: 'CAD',
    ratedDate: '2024-01-02',
    rate: '1.3300',
    source: 'manual_seed',
    fetchedAt: new Date(),
  });

  const stubFetcher = async (_start: string, _end: string) => ({
    observations: [
      { d: '2024-01-02', FXUSDCAD: { v: '1.3300' } }, // already exists
      { d: '2024-01-03', FXUSDCAD: { v: '1.3320' } }, // new
    ],
  });

  const inserted = await backfillUsdCadHistory({
    startDate: '2024-01-01',
    endDate: '2024-01-05',
    fetcher: stubFetcher,
  });
  assert.equal(inserted, 1);

  const rows = await FxRate.findAll({ order: [['ratedDate', 'ASC']] });
  assert.equal(rows.length, 2);
});

test('returns zero on fetcher hard failure (no throw)', async () => {
  const failingFetcher = async () => null;
  const inserted = await backfillUsdCadHistory({
    startDate: '2024-01-01',
    endDate: '2024-01-05',
    fetcher: failingFetcher,
  });
  assert.equal(inserted, 0);
  const rows = await FxRate.findAll();
  assert.equal(rows.length, 0);
});
