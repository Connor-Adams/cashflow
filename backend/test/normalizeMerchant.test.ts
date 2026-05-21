import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMerchant } from '../src/import/normalizeMerchant';

test('normalizeMerchant trims and collapses whitespace', () => {
  assert.equal(normalizeMerchant('  Foo   Bar  '), 'Foo Bar');
});

test('normalizeMerchant strips SQ * processor prefix', () => {
  assert.equal(normalizeMerchant('SQ *JOES COFFEE'), 'JOES COFFEE');
  assert.equal(normalizeMerchant('SQ *JOE&#39;S COFFEE TORONTO'), "JOE'S COFFEE TORONTO");
});

test('normalizeMerchant strips TST* prefix', () => {
  assert.equal(normalizeMerchant('TST*LOCAL BISTRO'), 'LOCAL BISTRO');
});

test('normalizeMerchant strips PAYPAL * prefix', () => {
  assert.equal(normalizeMerchant('PAYPAL *MERCHANT123'), 'MERCHANT123');
});

test('normalizeMerchant strips AMZN MKTP US* trailing identifier', () => {
  assert.equal(normalizeMerchant('AMZN MKTP US*A1B2C3D4'), 'AMZN MKTP US');
  assert.equal(normalizeMerchant('AMZN Mktp US*Z9Y8X7'), 'AMZN Mktp US');
});

test('normalizeMerchant strips STRIPE* and GOOGLE *', () => {
  assert.equal(normalizeMerchant('STRIPE*MERCHANT'), 'MERCHANT');
  assert.equal(normalizeMerchant('GOOGLE *DOMAINS'), 'DOMAINS');
});

test('normalizeMerchant strips trailing store/transit numbers', () => {
  assert.equal(normalizeMerchant('STARBUCKS #1234'), 'STARBUCKS');
  assert.equal(normalizeMerchant('TARGET STORE 5678'), 'TARGET');
  assert.equal(normalizeMerchant('SHELL OIL 91234'), 'SHELL OIL');
});

test('normalizeMerchant strips trailing US/CA city-state tails', () => {
  assert.equal(normalizeMerchant('JOE COFFEE TORONTO ON'), 'JOE COFFEE');
  assert.equal(normalizeMerchant('CAFE BAR NEW YORK NY US'), 'CAFE BAR');
  assert.equal(normalizeMerchant('SAM SHOP MISSISSAUGA ON CA'), 'SAM SHOP');
});

test('normalizeMerchant strips trailing phone numbers', () => {
  assert.equal(normalizeMerchant('PIZZA SHOP 416-555-1212'), 'PIZZA SHOP');
  assert.equal(normalizeMerchant('STORE 800.555.0199'), 'STORE');
});

test('normalizeMerchant is idempotent', () => {
  const once = normalizeMerchant('SQ *JOE COFFEE TORONTO ON #1234');
  const twice = normalizeMerchant(once);
  assert.equal(once, twice);
});

test('normalizeMerchant handles empty / non-string input', () => {
  assert.equal(normalizeMerchant(''), '');
  assert.equal(normalizeMerchant(null), '');
  assert.equal(normalizeMerchant(undefined), '');
});

test('normalizeMerchant leaves recognised cleaned merchants untouched', () => {
  assert.equal(normalizeMerchant('NETFLIX.COM'), 'NETFLIX.COM');
});
