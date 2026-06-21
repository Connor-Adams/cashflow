import { test } from 'node:test';
import assert from 'node:assert/strict';
import { txnMatchesVendor } from './matchReceiptToTransactions';
import type { Transaction } from '../models/Transaction';

function makeTxn(merchant: string): Transaction {
  return { merchantRaw: merchant, merchantClean: merchant } as Transaction;
}

test('uber_eats matches Uber Eats card descriptors', () => {
  assert.equal(txnMatchesVendor('uber_eats', makeTxn('UBER *EATS')), true);
  assert.equal(txnMatchesVendor('uber_eats', makeTxn('UBER EATS')), true);
});

test('uber matches ride descriptors but never Eats', () => {
  assert.equal(txnMatchesVendor('uber', makeTxn('UBER *TRIP')), true);
  assert.equal(txnMatchesVendor('uber', makeTxn('UBER TRIP HELP.UBER.COM')), true);
  assert.equal(txnMatchesVendor('uber', makeTxn('UBER *EATS')), false);
  assert.equal(txnMatchesVendor('uber', makeTxn('UBER EATS')), false);
});
