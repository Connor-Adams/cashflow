import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  itemNumbersMatch,
  pickVerifiedProduct,
  RESOLVE_VENDORS,
  resolveOneItemNumber,
} from '../src/import/enrichment/resolveCostcoProducts';
import type { CostcoProductData, CostcoScraperCaller, CostcoSearchHit } from '../src/integrations/costco/scraperClient';

test('RESOLVE_VENDORS is costco only', () => {
  assert.deepEqual(RESOLVE_VENDORS, ['costco']);
});

test('itemNumbersMatch compares digits-only, ignoring leading zeros and formatting', () => {
  assert.equal(itemNumbersMatch('1011242', '1011242'), true);
  assert.equal(itemNumbersMatch('0001011242', '1011242'), true);
  assert.equal(itemNumbersMatch('1011242', 'Item# 1011242'), true);
  assert.equal(itemNumbersMatch('1011242', '9999999'), false);
  assert.equal(itemNumbersMatch(null, '1011242'), false);
  assert.equal(itemNumbersMatch('1011242', null), false);
  assert.equal(itemNumbersMatch('', ''), false);
});

test('pickVerifiedProduct returns the candidate whose item number matches the receipt', () => {
  const candidates: CostcoProductData[] = [
    { itemNumber: '9999999', title: 'Wrong', imageUrl: 'a', url: 'u1', price: 1 },
    { itemNumber: '1011242', title: 'Right', imageUrl: 'b', url: 'u2', price: 2 },
  ];
  const hit = pickVerifiedProduct('1011242', candidates);
  assert.equal(hit?.url, 'u2');
});

test('pickVerifiedProduct returns null when no candidate matches', () => {
  const candidates: CostcoProductData[] = [
    { itemNumber: '9999999', title: 'Wrong', imageUrl: 'a', url: 'u1', price: 1 },
  ];
  assert.equal(pickVerifiedProduct('1011242', candidates), null);
});

test('pickVerifiedProduct returns null on empty candidate list', () => {
  assert.equal(pickVerifiedProduct('1011242', []), null);
});

function stubCaller(opts: {
  hits: CostcoSearchHit[];
  products: Record<string, CostcoProductData | null>;
  onCall?: () => void;
}): CostcoScraperCaller {
  return {
    source: 'stub',
    async search() {
      opts.onCall?.();
      return opts.hits;
    },
    async fetchProduct(url) {
      opts.onCall?.();
      return opts.products[url] ?? null;
    },
  };
}

test('resolveOneItemNumber -> resolved when a candidate item number matches', async () => {
  const caller = stubCaller({
    hits: [{ url: 'u1', title: 'a' }, { url: 'u2', title: 'b' }],
    products: {
      u1: { itemNumber: '9999999', title: 'Wrong', imageUrl: 'x', url: 'u1', price: 1 },
      u2: { itemNumber: '1011242', title: 'KS Org PB', imageUrl: 'img.jpg', url: 'u2', price: 12.99 },
    },
  });
  const out = await resolveOneItemNumber('1011242', 'KS ORG PNT BTR', caller);
  assert.equal(out.status, 'resolved');
  assert.equal(out.imageUrl, 'img.jpg');
  assert.equal(out.costcoUrl, 'u2');
  assert.equal(out.officialName, 'KS Org PB');
  assert.equal(out.onlinePrice, '12.99');
  assert.equal(out.source, 'stub');
});

test('resolveOneItemNumber -> not_found when no candidate matches', async () => {
  const caller = stubCaller({
    hits: [{ url: 'u1', title: 'a' }],
    products: { u1: { itemNumber: '9999999', title: 'Wrong', imageUrl: 'x', url: 'u1', price: 1 } },
  });
  const out = await resolveOneItemNumber('1011242', 'KS ORG PNT BTR', caller);
  assert.equal(out.status, 'not_found');
  assert.equal(out.imageUrl, null);
});

test('resolveOneItemNumber -> not_found when search returns nothing', async () => {
  const caller = stubCaller({ hits: [], products: {} });
  const out = await resolveOneItemNumber('1011242', 'X', caller);
  assert.equal(out.status, 'not_found');
});

test('resolveOneItemNumber fetches at most MAX_CANDIDATES (2) product pages', async () => {
  let calls = 0;
  const caller = stubCaller({
    hits: [
      { url: 'u1', title: 'a' }, { url: 'u2', title: 'b' }, { url: 'u3', title: 'c' },
    ],
    products: {
      u1: { itemNumber: '1', title: '', imageUrl: null, url: 'u1', price: null },
      u2: { itemNumber: '2', title: '', imageUrl: null, url: 'u2', price: null },
      u3: { itemNumber: '1011242', title: '', imageUrl: 'late', url: 'u3', price: null },
    },
    onCall: () => { calls += 1; },
  });
  const out = await resolveOneItemNumber('1011242', 'X', caller);
  // 1 search + 2 product fetches = 3 calls; u3 never fetched, so stays not_found.
  assert.equal(calls, 3);
  assert.equal(out.status, 'not_found');
});

test('resolveOneItemNumber -> error when the caller throws', async () => {
  const caller: CostcoScraperCaller = {
    source: 'boom',
    async search() { throw new Error('network'); },
    async fetchProduct() { return null; },
  };
  const out = await resolveOneItemNumber('1011242', 'X', caller);
  assert.equal(out.status, 'error');
});
