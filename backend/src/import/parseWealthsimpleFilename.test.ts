import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWealthsimpleFilename, parseWsCreditCardPdfWsid } from './parseWealthsimpleFilename';

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

test('parses Corporate chequing (space) monthly statement', () => {
  const r = parseWealthsimpleFilename(
    'Corporate chequing-2025-09-01-monthly-statement-transactions-WKCORPCHQ09CAD.csv',
  );
  assert.ok(r);
  assert.equal(r.productHint, 'corporate_chequing');
  assert.equal(r.wsid, 'WKCORPCHQ09CAD');
  assert.equal(r.periodEnd, '2025-09-01');
});

test('parses Corporate-chequing (hyphenated) monthly statement', () => {
  const r = parseWealthsimpleFilename(
    'Corporate-chequing-2025-10-01-monthly-statement-transactions-WKCORPCHQ10CAD.csv',
  );
  assert.ok(r);
  assert.equal(r.productHint, 'corporate_chequing');
  assert.equal(r.wsid, 'WKCORPCHQ10CAD');
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

test('parseWsCreditCardPdfWsid extracts the WSID from a WS credit-card PDF filename', () => {
  // The WS credit-card statement body only prints the card last-4; the stable
  // WS account id (WSID) lives solely in the renamed PDF filename prefix.
  assert.equal(parseWsCreditCardPdfWsid('C13BRX957CAD_2026-06_CREDIT_CARD.pdf'), 'C13BRX957CAD');
});

test('parseWsCreditCardPdfWsid tolerates path prefixes and case in the suffix', () => {
  assert.equal(parseWsCreditCardPdfWsid('/tmp/uploads/C13BRX957CAD_2025-09_credit_card.pdf'), 'C13BRX957CAD');
});

test('parseWsCreditCardPdfWsid returns null for non-WS-CC filenames', () => {
  assert.equal(parseWsCreditCardPdfWsid('statement.pdf'), null);
  assert.equal(parseWsCreditCardPdfWsid('C13BRX957CAD_2026-06_CREDIT_CARD.csv'), null);
  assert.equal(parseWsCreditCardPdfWsid('RBC_2026-06_VISA.pdf'), null);
});
