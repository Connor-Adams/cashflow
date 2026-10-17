import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

let models: typeof import('../../models');
let picker: typeof import('./picker');

before(async () => {
  models = await import('../../models');
  await models.sequelize.sync();
  picker = await import('./picker');
});

after(async () => {
  await models.sequelize.close();
});

beforeEach(async () => {
  await models.ProviderJobLog.destroy({ where: {} });
  await models.Security.destroy({ where: {} });
});

const NOW = new Date('2026-10-16T15:00:00Z');
const HOUR_MS = 3600 * 1000;

async function makeSecurity(symbol: string, currency: string) {
  return models.Security.create({
    householdId: 1,
    symbol,
    name: symbol,
    assetType: 'EQUITY',
    currency,
  });
}

async function log(fn: string, symbol: string, status: 'ok' | 'not_found' | 'error', hoursAgo: number) {
  await models.ProviderJobLog.create({
    provider: 'yahoo',
    function: fn,
    symbol,
    status,
    httpStatus: null,
    errorMessage: null,
    fetchedAt: new Date(NOW.getTime() - hoursAgo * HOUR_MS),
  });
}

test('an unresolvable symbol that just failed on every suffix does not win the next tick', async () => {
  // NFLD sorts first by id and never resolves; before the fix it scored
  // +Infinity forever and starved every other security of QUOTE refreshes.
  await makeSecurity('NFLD', 'CAD');
  await makeSecurity('XEQT', 'CAD');
  for (const s of ['NFLD.TO', 'NFLD.V', 'NFLD.CN']) await log('QUOTE', s, 'not_found', 0.1);
  await log('QUOTE', 'XEQT.TO', 'ok', 48);

  const item = await picker.pickNext({ minAgeSeconds: 3600, now: NOW, functions: ['QUOTE'] });
  assert.ok(item);
  assert.equal(item.yahooSymbol, 'XEQT.TO');
});

test('a recent error attempt also counts as an attempt', async () => {
  await makeSecurity('NFLD', 'CAD');
  await makeSecurity('XEQT', 'CAD');
  await log('QUOTE', 'NFLD.TO', 'error', 0.1);
  await log('QUOTE', 'XEQT.TO', 'ok', 48);

  const item = await picker.pickNext({ minAgeSeconds: 3600, now: NOW, functions: ['QUOTE'] });
  assert.equal(item?.yahooSymbol, 'XEQT.TO');
});

test('a failed symbol is retried once its backoff (the function target age) elapses', async () => {
  await makeSecurity('NFLD', 'CAD');
  for (const s of ['NFLD.TO', 'NFLD.V', 'NFLD.CN']) await log('QUOTE', s, 'not_found', 30);

  const item = await picker.pickNext({ minAgeSeconds: 3600, now: NOW, functions: ['QUOTE'] });
  assert.equal(item?.yahooSymbol, 'NFLD.TO');
  assert.equal(item?.lastFetchedAt, null, 'lastFetchedAt reports the last successful fetch only');
});

test('a symbol resolved on an alternate suffix counts as fresh', async () => {
  // The ok row is logged under the resolved symbol (SMALL.V), not the
  // primary candidate (SMALL.TO) the picker keys on.
  await makeSecurity('SMALL', 'CAD');
  await log('QUOTE', 'SMALL.TO', 'not_found', 1);
  await log('QUOTE', 'SMALL.V', 'ok', 1);

  const item = await picker.pickNext({ minAgeSeconds: 3600, now: NOW, functions: ['QUOTE'] });
  assert.equal(item, null);
});

test('a never-fetched security still outranks a stale one', async () => {
  await makeSecurity('XEQT', 'CAD');
  await makeSecurity('VFV', 'CAD');
  await log('QUOTE', 'XEQT.TO', 'ok', 48);

  const item = await picker.pickNext({ minAgeSeconds: 3600, now: NOW, functions: ['QUOTE'] });
  assert.equal(item?.yahooSymbol, 'VFV.TO');
  assert.equal(item?.stalenessRatio, Number.POSITIVE_INFINITY);
});
