import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWealthsimpleFilename } from '../src/import/parseWealthsimpleFilename';

test('parses Chequing monthly statement', () => {
  const r = parseWealthsimpleFilename(
    'Chequing-2025-01-01-monthly-statement-transactions-WK3DD9X35CAD.csv',
  );
  assert.ok(r);
  assert.equal(r.wsid, 'WK3DD9X35CAD');
  assert.equal(r.productHint, 'chequing');
  assert.equal(r.periodEnd, '2025-01-01');
  assert.equal(r.isCreditCard, false);
});

test('parses TFSA monthly statement', () => {
  const r = parseWealthsimpleFilename(
    'TFSA-2025-01-01-monthly-statement-transactions-HQ6LMLTK8CAD.csv',
  );
  assert.ok(r);
  assert.equal(r.wsid, 'HQ6LMLTK8CAD');
  assert.equal(r.productHint, 'tfsa');
  assert.equal(r.periodEnd, '2025-01-01');
  assert.equal(r.isCreditCard, false);
});

test('parses FHSA monthly statement', () => {
  const r = parseWealthsimpleFilename(
    'FHSA-2025-03-01-monthly-statement-transactions-HQABC1234CAD.csv',
  );
  assert.ok(r);
  assert.equal(r.wsid, 'HQABC1234CAD');
  assert.equal(r.productHint, 'fhsa');
});

test('parses Corporate-investing (hyphenated) monthly statement', () => {
  const r = parseWealthsimpleFilename(
    'Corporate-investing-2025-08-01-monthly-statement-transactions-HQ8H0GZ07CAD.csv',
  );
  assert.ok(r);
  assert.equal(r.wsid, 'HQ8H0GZ07CAD');
  assert.equal(r.productHint, 'corporate_investing');
  assert.equal(r.periodEnd, '2025-08-01');
});

test('parses Corporate investing (space) monthly statement — same WSID + hint', () => {
  const r = parseWealthsimpleFilename(
    'Corporate investing-2025-07-01-monthly-statement-transactions-HQ8H0GZ07CAD.csv',
  );
  assert.ok(r);
  assert.equal(r.wsid, 'HQ8H0GZ07CAD');
  assert.equal(r.productHint, 'corporate_investing');
});

test('parses Save for business monthly statement', () => {
  const r = parseWealthsimpleFilename(
    'Save for business-2025-07-01-monthly-statement-transactions-WKSAVE7777CAD.csv',
  );
  assert.ok(r);
  assert.equal(r.productHint, 'save_for_business');
  assert.equal(r.wsid, 'WKSAVE7777CAD');
});

test('parses Non-registered-margin monthly statement', () => {
  const r = parseWealthsimpleFilename(
    'Non-registered-margin-2025-09-01-monthly-statement-transactions-HQMARGIN09CAD.csv',
  );
  assert.ok(r);
  assert.equal(r.productHint, 'margin');
  assert.equal(r.wsid, 'HQMARGIN09CAD');
});

test('parses Crypto monthly statement', () => {
  const r = parseWealthsimpleFilename(
    'Crypto-2025-02-01-monthly-statement-transactions-HQ6R28910CAD.csv',
  );
  assert.ok(r);
  assert.equal(r.productHint, 'crypto');
  assert.equal(r.wsid, 'HQ6R28910CAD');
});

test('parses Wealthsimple credit-card statement', () => {
  const r = parseWealthsimpleFilename(
    'Wealthsimple-credit-card-2025-11-01-credit-card-statement-transactions-ca-credit-card-oaa9hcx83A.csv',
  );
  assert.ok(r);
  assert.equal(r.productHint, 'credit_card');
  assert.equal(r.wsid, 'oaa9hcx83A');
  assert.equal(r.periodEnd, '2025-11-01');
  assert.equal(r.isCreditCard, true);
});

test('rejects unrelated legacy filename', () => {
  assert.equal(parseWealthsimpleFilename('Amex_2025_01.csv'), null);
});
