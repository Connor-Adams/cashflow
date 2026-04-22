import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPositiveFlow } from '../src/summary/classifyTransactionFlow';

test('classifyPositiveFlow marks payment-like rows as payments', () => {
  assert.equal(
    classifyPositiveFlow({ merchantRaw: 'ONLINE PAYMENT THANK YOU' }),
    'payment'
  );
  assert.equal(
    classifyPositiveFlow({ merchantRaw: 'PRE-AUTHORIZED PAYMENT' }),
    'payment'
  );
});

test('classifyPositiveFlow keeps refund-like rows as credits', () => {
  assert.equal(
    classifyPositiveFlow({ merchantRaw: 'MERCHANDISE REFUND' }),
    'credit'
  );
  assert.equal(
    classifyPositiveFlow({ merchantRaw: 'STATEMENT CREDIT' }),
    'credit'
  );
});
