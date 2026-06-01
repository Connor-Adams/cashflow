import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCounterparty } from '../src/import/extractCounterparty.js';

test('person pattern -> kind person', () => {
  assert.deepEqual(
    extractCounterparty('INTERAC E-TRANSFER FROM JANE DOE REF 8842', 'checking'),
    { name: 'JANE DOE', kind: 'person' },
  );
});
test('payroll pattern -> kind payroll', () => {
  assert.deepEqual(
    extractCounterparty('PAYROLL DEPOSIT ACME CORP', 'checking'),
    { name: 'ACME CORP', kind: 'payroll' },
  );
});
test('out-of-scope account -> null', () => {
  assert.equal(extractCounterparty('INTERAC E-TRANSFER FROM JANE DOE', 'credit_card'), null);
});
