import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCounterparty } from './extractCounterparty';
import type { AccountType } from '@cashflow/shared';

const IN_SCOPE: AccountType[] = ['checking', 'savings', 'cash'];
const OUT_OF_SCOPE: AccountType[] = ['credit_card', 'loan', 'investment'];

test('out-of-scope account types always return null', () => {
  for (const t of OUT_OF_SCOPE) {
    assert.equal(
      extractCounterparty('INTERAC E-TFR FROM JANE DOE', t),
      null,
      `expected null for accountType ${t}`,
    );
  }
});

test('in-scope: Interac e-transfer FROM with full INTERAC prefix', () => {
  for (const t of IN_SCOPE) {
    assert.equal(
      extractCounterparty('INTERAC E-TRANSFER FROM JANE DOE', t)?.name,
      'JANE DOE',
    );
  }
});

test('in-scope: Interac e-transfer with E-TFR abbrev', () => {
  assert.equal(
    extractCounterparty('INTERAC E-TFR FROM JANE DOE', 'checking')?.name,
    'JANE DOE',
  );
  assert.equal(
    extractCounterparty('INTERAC E-TFR TO MIKE SMITH', 'savings')?.name,
    'MIKE SMITH',
  );
});

test('in-scope: bare E-TRANSFER without INTERAC prefix', () => {
  assert.equal(
    extractCounterparty('E-TRANSFER FROM JANE DOE', 'checking')?.name,
    'JANE DOE',
  );
  assert.equal(
    extractCounterparty('E-TRANSFER TO MIKE SMITH', 'checking')?.name,
    'MIKE SMITH',
  );
});

test('in-scope: SEND/RECV e-transfer variants', () => {
  assert.equal(
    extractCounterparty('SEND E-TFR JOHN SMITH', 'checking')?.name,
    'JOHN SMITH',
  );
  assert.equal(
    extractCounterparty('RECV E-TFR JANE DOE', 'checking')?.name,
    'JANE DOE',
  );
  assert.equal(
    extractCounterparty('RECEIVED E-TFR JANE DOE', 'checking')?.name,
    'JANE DOE',
  );
});

test('in-scope: Zelle FROM/TO', () => {
  assert.equal(
    extractCounterparty('ZELLE FROM SARAH KIM', 'checking')?.name,
    'SARAH KIM',
  );
  assert.equal(
    extractCounterparty('ZELLE TO BOB JONES', 'checking')?.name,
    'BOB JONES',
  );
});

test('in-scope: Venmo payment/cashout', () => {
  assert.equal(
    extractCounterparty('VENMO PAYMENT FROM SARAH', 'checking')?.name,
    'SARAH',
  );
  assert.equal(
    extractCounterparty('VENMO CASHOUT TO BOB', 'checking')?.name,
    'BOB',
  );
});

test('in-scope: Cash App asterisk form', () => {
  assert.equal(
    extractCounterparty('CASH APP*JANE DOE', 'checking')?.name,
    'JANE DOE',
  );
  assert.equal(
    extractCounterparty('CASHAPP*MIKE', 'checking')?.name,
    'MIKE',
  );
});

test('in-scope: Cash App with FROM/TO', () => {
  assert.equal(
    extractCounterparty('CASH APP FROM JANE DOE', 'checking')?.name,
    'JANE DOE',
  );
});

test('in-scope: payroll / direct deposit captures payer', () => {
  assert.equal(
    extractCounterparty('PAYROLL DEPOSIT ACME CORP', 'checking')?.name,
    'ACME CORP',
  );
  assert.equal(
    extractCounterparty('DIRECT DEPOSIT ACME PAYROLL', 'checking')?.name,
    'ACME PAYROLL',
  );
  assert.equal(
    extractCounterparty('DIRECT DEP ACME INC', 'checking')?.name,
    'ACME INC',
  );
});

test('in-scope: trailing REF#/numeric noise is stripped', () => {
  assert.equal(
    extractCounterparty('INTERAC E-TFR FROM JANE DOE REF# ABC123', 'checking')?.name,
    'JANE DOE',
  );
  assert.equal(
    extractCounterparty('INTERAC E-TFR FROM JANE DOE 12345', 'checking')?.name,
    'JANE DOE',
  );
});

test('in-scope: whitespace collapses and trims', () => {
  assert.equal(
    extractCounterparty('INTERAC E-TFR FROM   JANE   DOE  ', 'checking')?.name,
    'JANE DOE',
  );
});

test('in-scope: false-positive guards (TO/FROM as English word in merchant)', () => {
  assert.equal(extractCounterparty('TIM HORTONS TO GO', 'checking'), null);
  assert.equal(extractCounterparty('FROM THE GROUND COFFEE', 'checking'), null);
  assert.equal(extractCounterparty('WALMART SUPERCENTER', 'checking'), null);
  assert.equal(extractCounterparty('STARBUCKS COFFEE #4567', 'checking'), null);
  assert.equal(extractCounterparty('AMAZON.CA*1234567', 'checking'), null);
});

test('in-scope: empty / whitespace input returns null', () => {
  assert.equal(extractCounterparty('', 'checking'), null);
  assert.equal(extractCounterparty('   ', 'checking'), null);
});

test('in-scope: mixed case input still matches', () => {
  assert.equal(
    extractCounterparty('Interac e-Transfer from Jane Doe', 'checking')?.name,
    'Jane Doe',
  );
});

test('in-scope: very short single-word name still captured', () => {
  assert.equal(
    extractCounterparty('INTERAC E-TFR FROM SU', 'checking')?.name,
    'SU',
  );
});

test('in-scope: name with hyphen/apostrophe preserved', () => {
  assert.equal(
    extractCounterparty("INTERAC E-TFR FROM SEAN O'BRIEN", 'checking')?.name,
    "SEAN O'BRIEN",
  );
  assert.equal(
    extractCounterparty('INTERAC E-TFR FROM MARY-JANE WATSON', 'checking')?.name,
    'MARY-JANE WATSON',
  );
});
