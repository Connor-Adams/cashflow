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

test('normalizeMerchant edge case: 2-word string ending in state code is stripped to one word', () => {
  // Documented behaviour: with no recognised city, the trailing state token is
  // stripped. Real merchant strings rarely take this form so this is acceptable.
  assert.equal(normalizeMerchant('SHOP ON'), 'SHOP');
});

test('normalizeMerchant edge case: trailing CA is treated as Canada, not California', () => {
  // Known limitation: CA appears in both COUNTRY_SET (Canada) and STATE_PROV_SET
  // (California). The country check fires first — consuming CA as country — then
  // the preceding token (MALIBU) is not a state code, so stripCityStateTail bails
  // out and returns the string unchanged. US merchant strings ending in "... CA"
  // with no other state token are therefore NOT stripped.
  assert.equal(normalizeMerchant('STORE MALIBU CA'), 'STORE MALIBU CA');
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

test('normalizeMerchant strips mid-string numeric store IDs', () => {
  assert.equal(normalizeMerchant("MCDONALD'S #12164 GUELPH"), "MCDONALD'S");
  assert.equal(normalizeMerchant('STARBUCKS 04747 GUELPH'), 'STARBUCKS');
  assert.equal(normalizeMerchant('PETRO-CANADA 10585 GUELPH'), 'PETRO-CANADA');
  assert.equal(normalizeMerchant('WALMART 3144 3144 GUELPH'), 'WALMART');
  assert.equal(normalizeMerchant('DOMINOS PIZZA 10263 GUELPH'), 'DOMINOS PIZZA');
});

test('normalizeMerchant strips mid-string alphanumeric store IDs', () => {
  assert.equal(normalizeMerchant('SHELL C12587 GUELPH'), 'SHELL');
  assert.equal(normalizeMerchant('COSTCO GAS W1168'), 'COSTCO GAS');
});

test('normalizeMerchant does not strip short leading numbers', () => {
  // 500 is part of the merchant name (sports box seat), don't drop it.
  // TORONTO stays because no state code follows and no store ID precedes it.
  assert.equal(normalizeMerchant('500 LOGE CLUB TORONTO'), '500 LOGE CLUB TORONTO');
  // Single-digit '# 5' (with space) isn't a store ID under our regex.
  assert.equal(normalizeMerchant('ZEHRS GUELPH CLAIR # 5'), 'ZEHRS GUELPH CLAIR # 5');
});
