import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';
import type { CostcoScraperCaller, CostcoProductData } from '../../src/integrations/costco/scraperClient.js';

let testDb: PgTestDb;
let models: typeof import('../../src/models/index.js');
let resolve: typeof import('../../src/import/enrichment/resolveCostcoProducts.js');

before(async () => {
  testDb = await setupPgTestDb('costco_products');
  models = await import('../../src/models/index.js');
  resolve = await import('../../src/import/enrichment/resolveCostcoProducts.js');
});

after(async () => {
  await teardownPgTestDb(testDb);
});

function callerFor(products: Record<string, CostcoProductData | null>, hits: Record<string, string[]>): CostcoScraperCaller {
  return {
    source: 'stub',
    async search(keyword) {
      return (hits[keyword] ?? []).map((url) => ({ url, title: keyword }));
    },
    async fetchProduct(url) { return products[url] ?? null; },
  };
}

test('resolveCostcoProductsForItemNumbers caches resolved + not_found rows', async () => {
  const { CostcoProduct } = models;
  const caller = callerFor(
    {
      u_match: { itemNumber: '1011242', title: 'KS Org PB', imageUrl: 'img.jpg', url: 'u_match', price: 12.99 },
      u_miss: { itemNumber: '9999999', title: 'Wrong', imageUrl: 'x', url: 'u_miss', price: 1 },
    },
    { 'KS ORG PNT BTR': ['u_match'], 'WAREHOUSE ONLY': ['u_miss'] },
  );

  await resolve.resolveCostcoProductsForItemNumbers(
    [
      { itemNumber: '1011242', name: 'KS ORG PNT BTR' },
      { itemNumber: '5550000', name: 'WAREHOUSE ONLY' },
    ],
    caller,
  );

  const resolved = await CostcoProduct.findOne({ where: { itemNumber: '1011242' } });
  assert.equal(resolved?.status, 'resolved');
  assert.equal(resolved?.imageUrl, 'img.jpg');
  assert.equal(resolved?.costcoUrl, 'u_match');

  const missed = await CostcoProduct.findOne({ where: { itemNumber: '5550000' } });
  assert.equal(missed?.status, 'not_found');
  assert.equal(missed?.imageUrl, null);
});

test('already-cached item numbers (resolved/not_found) are not re-queried', async () => {
  const { CostcoProduct } = models;
  let searchCalls = 0;
  const caller: CostcoScraperCaller = {
    source: 'stub',
    async search() { searchCalls += 1; return []; },
    async fetchProduct() { return null; },
  };
  await resolve.resolveCostcoProductsForItemNumbers(
    [{ itemNumber: '1011242', name: 'KS ORG PNT BTR' }, { itemNumber: '5550000', name: 'WAREHOUSE ONLY' }],
    caller,
  );
  assert.equal(searchCalls, 0);
  assert.equal((await CostcoProduct.findOne({ where: { itemNumber: '1011242' } }))?.status, 'resolved');
});

test('per-run item cap bounds how many new item numbers are attempted', async () => {
  let searchCalls = 0;
  const caller: CostcoScraperCaller = {
    source: 'stub',
    async search() { searchCalls += 1; return []; },
    async fetchProduct() { return null; },
  };
  await resolve.resolveCostcoProductsForItemNumbers(
    [
      { itemNumber: '6000001', name: 'a' },
      { itemNumber: '6000002', name: 'b' },
      { itemNumber: '6000003', name: 'c' },
    ],
    caller,
    { maxItems: 2 },
  );
  assert.equal(searchCalls, 2);
});

test('resolved cache rows expose imageUrl + costcoUrl for the read path', async () => {
  const { CostcoProduct } = models;
  const rows = await CostcoProduct.findAll({ where: { itemNumber: '1011242', status: 'resolved' } });
  const map = new Map(rows.map((p) => [p.itemNumber, p]));
  assert.equal(map.get('1011242')?.imageUrl, 'img.jpg');
  assert.equal(map.get('1011242')?.costcoUrl, 'u_match');
});
