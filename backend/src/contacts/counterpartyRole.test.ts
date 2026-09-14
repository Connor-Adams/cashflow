import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCounterpartyRole, resolveLedgerRole } from './counterpartyRole';

test('isCounterpartyRole accepts the vocabulary and rejects anything else', () => {
  assert.equal(isCounterpartyRole('loan'), true);
  assert.equal(isCounterpartyRole('loc_interest'), true);
  assert.equal(isCounterpartyRole('owner_draw'), false, 'that belongs to transfer_purpose');
  assert.equal(isCounterpartyRole(''), false);
  assert.equal(isCounterpartyRole(null), false);
});

test('an explicit loan on an outflow counts as a loan', () => {
  assert.deepEqual(
    resolveLedgerRole({ role: 'loan', amount: -40, loanDefault: false }),
    { effect: 'loan', mismatch: false },
  );
});

test('an explicit repayment on an inflow counts as a repayment', () => {
  assert.deepEqual(
    resolveLedgerRole({ role: 'repayment', amount: 600, loanDefault: false }),
    { effect: 'repayment', mismatch: false },
  );
});

test('a non-debt role never counts, whatever the direction', () => {
  for (const role of ['purchase', 'business', 'rent', 'gift', 'self', 'loc_interest']) {
    assert.deepEqual(
      resolveLedgerRole({ role, amount: -3648, loanDefault: true }),
      { effect: 'none', mismatch: false },
      `${role} must not create a debt`,
    );
  }
});

test('a role contradicting its direction resolves by direction and reports a mismatch', () => {
  assert.deepEqual(
    resolveLedgerRole({ role: 'loan', amount: 600, loanDefault: false }),
    { effect: 'repayment', mismatch: true },
  );
  assert.deepEqual(
    resolveLedgerRole({ role: 'repayment', amount: -600, loanDefault: false }),
    { effect: 'loan', mismatch: true },
  );
});

test('untagged rows follow the contact default', () => {
  assert.deepEqual(
    resolveLedgerRole({ role: null, amount: -200, loanDefault: true }),
    { effect: 'loan', mismatch: false },
  );
  assert.deepEqual(
    resolveLedgerRole({ role: null, amount: 200, loanDefault: true }),
    { effect: 'repayment', mismatch: false },
  );
  assert.deepEqual(
    resolveLedgerRole({ role: null, amount: -200, loanDefault: false }),
    { effect: 'none', mismatch: false },
  );
});

test('zero-amount rows never count', () => {
  assert.deepEqual(
    resolveLedgerRole({ role: 'loan', amount: 0, loanDefault: true }),
    { effect: 'none', mismatch: false },
  );
});

test('an unknown stored role is inert rather than throwing', () => {
  assert.deepEqual(
    resolveLedgerRole({ role: 'nonsense', amount: -40, loanDefault: true }),
    { effect: 'none', mismatch: false },
  );
});
