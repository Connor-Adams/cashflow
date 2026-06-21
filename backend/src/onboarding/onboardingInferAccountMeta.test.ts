/**
 * Unit tests for #259 onboarding account-metadata inference. Pure function —
 * no DB, no auth. Covers the three inference paths and the no-match fallback
 * that drives the wizard's name/type prompt (AC #4, #5).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferAccountMeta } from './inferAccountMeta';
import {
  toAccountColumnType,
  isOnboardingAccountType,
} from './accountType';

const buf = (s: string) => Buffer.from(s, 'utf8');

test('Wealthsimple chequing filename infers name + checking type', () => {
  const meta = inferAccountMeta({
    fileName:
      'Chequing-2025-01-01-monthly-statement-transactions-WK3DD9X35CAD.csv',
    buffer: buf('date,transaction\n'),
  });
  assert.deepEqual(meta, { name: 'Wealthsimple Chequing', type: 'checking' });
});

test('Wealthsimple credit-card filename infers credit type', () => {
  const meta = inferAccountMeta({
    fileName:
      'Wealthsimple-credit-card-2025-12-01-credit-card-statement-transactions-ca-credit-card-oaa9hcx83A.csv',
    buffer: buf('transaction_date,amount\n'),
  });
  assert.equal(meta?.name, 'Wealthsimple Credit Card');
  assert.equal(meta?.type, 'credit');
});

test('Wealthsimple TFSA filename infers investment type', () => {
  const meta = inferAccountMeta({
    fileName: 'TFSA-2025-01-01-monthly-statement-transactions-HQ8H0GZ07CAD.csv',
    buffer: buf('date,transaction\n'),
  });
  assert.equal(meta?.type, 'investment');
});

test('OFX <ACCTID> infers a masked account name', () => {
  const ofx = `
    <OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS>
    <BANKACCTFROM><ACCTID>000123456789<ACCTTYPE>CHECKING</BANKACCTFROM>
    </STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>
  `;
  const meta = inferAccountMeta({ fileName: 'export.ofx', buffer: buf(ofx) });
  assert.equal(meta?.name, 'Account ••6789');
  assert.equal(meta?.type, 'checking');
});

test('OFX credit-card statement infers credit type via CCACCTFROM', () => {
  const ofx = `
    <OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS>
    <CCACCTFROM><ACCTID>5500001234</CCACCTFROM>
    </CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>
  `;
  const meta = inferAccountMeta({ fileName: 'card.qfx', buffer: buf(ofx) });
  assert.equal(meta?.name, 'Account ••1234');
  assert.equal(meta?.type, 'credit');
});

test('CardName_YYYY_MM.csv infers a name with no type', () => {
  const meta = inferAccountMeta({
    fileName: 'Amex_2025_01.csv',
    buffer: buf('Date,Description,Amount\n'),
  });
  assert.equal(meta?.name, 'Amex');
  assert.equal(meta?.type, undefined);
});

test('unrecognized CSV filename yields null (caller must prompt)', () => {
  const meta = inferAccountMeta({
    fileName: 'statement.csv',
    buffer: buf('Date,Description,Amount\n'),
  });
  assert.equal(meta, null);
});

test('PDF without filename hint yields null', () => {
  const meta = inferAccountMeta({
    fileName: 'mystery.pdf',
    buffer: buf('%PDF-1.4'),
  });
  assert.equal(meta, null);
});

test('toAccountColumnType maps credit -> credit_card, passes others', () => {
  assert.equal(toAccountColumnType('credit'), 'credit_card');
  assert.equal(toAccountColumnType('checking'), 'checking');
  assert.equal(toAccountColumnType('savings'), 'savings');
  assert.equal(toAccountColumnType('investment'), 'investment');
  assert.equal(toAccountColumnType('other'), 'other');
});

test('isOnboardingAccountType guards the enum', () => {
  assert.equal(isOnboardingAccountType('checking'), true);
  assert.equal(isOnboardingAccountType('credit'), true);
  assert.equal(isOnboardingAccountType('credit_card'), false);
  assert.equal(isOnboardingAccountType('bogus'), false);
  assert.equal(isOnboardingAccountType(undefined), false);
});
