import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeGoogleBestEffortResolver } from '../src/integrations/costco/googleImageCaller';

function fakeFetch(payload: unknown, ok = true): typeof fetch {
  return (async () =>
    ({ ok, status: ok ? 200 : 500, async json() { return payload; }, async text() { return JSON.stringify(payload); } }) as Response) as unknown as typeof fetch;
}

test('verified=true when item number is recoverable from result text and matches', async () => {
  const resolve = makeGoogleBestEffortResolver(
    { apiKey: 'k', cx: 'c' },
    fakeFetch({ items: [
      { link: 'https://img.costco.com/a.jpg', title: 'KS Org PB Item 1011242', image: { contextLink: 'https://www.costco.com/x.product.100.html' } },
    ] }),
  );
  const out = await resolve('1011242', 'KS ORG PNT BTR');
  assert.equal(out.status, 'resolved');
  assert.equal(out.verified, true);
  assert.equal(out.imageUrl, 'https://img.costco.com/a.jpg');
  assert.equal(out.costcoUrl, 'https://www.costco.com/x.product.100.html');
});

test('verified=false guess when no item number recoverable (takes top result)', async () => {
  const resolve = makeGoogleBestEffortResolver(
    { apiKey: 'k', cx: 'c' },
    fakeFetch({ items: [
      { link: 'https://img.costco.com/top.jpg', title: 'Some Costco Product', image: { contextLink: 'https://www.costco.com/y.product.200.html' } },
    ] }),
  );
  const out = await resolve('1011242', 'KS ORG PNT BTR');
  assert.equal(out.status, 'resolved');
  assert.equal(out.verified, false);
  assert.equal(out.imageUrl, 'https://img.costco.com/top.jpg');
});

test('a recoverable-but-mismatched item number is NOT accepted as verified (guess instead)', async () => {
  const resolve = makeGoogleBestEffortResolver(
    { apiKey: 'k', cx: 'c' },
    fakeFetch({ items: [
      { link: 'https://img.costco.com/wrong.jpg', title: 'Other Item 9999999', image: { contextLink: 'https://www.costco.com/z.product.300.html' } },
    ] }),
  );
  const out = await resolve('1011242', 'X');
  assert.equal(out.status, 'resolved');
  assert.equal(out.verified, false);
  assert.equal(out.imageUrl, 'https://img.costco.com/wrong.jpg');
});

test('not_found when Google returns no items', async () => {
  const resolve = makeGoogleBestEffortResolver({ apiKey: 'k', cx: 'c' }, fakeFetch({ items: [] }));
  const out = await resolve('1011242', 'X');
  assert.equal(out.status, 'not_found');
});

test('error when fetch fails', async () => {
  const resolve = makeGoogleBestEffortResolver({ apiKey: 'k', cx: 'c' }, fakeFetch({}, false));
  const out = await resolve('1011242', 'X');
  assert.equal(out.status, 'error');
});
