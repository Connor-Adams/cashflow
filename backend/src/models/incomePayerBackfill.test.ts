import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePayer,
  deriveIncomePayers,
  decideRetag,
} from '../../scripts/incomePayerBackfill';

// Household 1 member display names — drive the heuristic's own-name exclusion.
const OWNER_NAMES = ['Connor Adams', 'LingLing'];

// Rows mirroring real prod merchant_raw narrations (household 1).
const INCOME_ANCHOR = {
  merchantRaw: 'Direct deposit from CDG LABS INC',
  merchantClean: 'Direct deposit from CDG LABS INC',
  amount: 7229.27,
};
const OWN_NAME_DEPOSIT = {
  merchantRaw: 'Direct deposit from ADAMS CONNOR DO',
  merchantClean: 'Direct deposit from ADAMS CONNOR DO',
  amount: 7954.63,
};
const WS_CONTRIBUTION = {
  merchantRaw: 'Contribution (executed at 2025-08-05)',
  merchantClean: 'Contribution',
  amount: 7154.51,
};

test('deriveIncomePayers: an external employer enters the payer set', () => {
  const payers = deriveIncomePayers([INCOME_ANCHOR], OWNER_NAMES);
  assert.ok(payers.has('cdg labs inc'));
});

test('deriveIncomePayers: an own-name self-deposit is excluded', () => {
  const payers = deriveIncomePayers([OWN_NAME_DEPOSIT], OWNER_NAMES);
  assert.equal(payers.size, 0);
});

test('deriveIncomePayers: a Wealthsimple internal movement is excluded', () => {
  const payers = deriveIncomePayers([WS_CONTRIBUTION], OWNER_NAMES);
  assert.equal(payers.size, 0);
});

test('decideRetag: "Misc Payment <known employer>" becomes income', () => {
  const payers = new Set(['cdg labs inc']);
  const row = {
    merchantRaw: 'Misc Payment CDG LABS INC',
    merchantClean: 'Misc Payment CDG LABS INC',
    amount: 7160.51,
    txnType: 'unknown',
  };
  assert.equal(decideRetag(row, payers, OWNER_NAMES), true);
});

test('decideRetag: a Wealthsimple Contribution stays put', () => {
  const payers = new Set(['cdg labs inc']);
  const row = { ...WS_CONTRIBUTION, txnType: 'unknown' };
  assert.equal(decideRetag(row, payers, OWNER_NAMES), false);
});

test('decideRetag: an Interac e-Transfer Received stays a transfer', () => {
  const payers = new Set(['cdg labs inc']);
  const row = {
    merchantRaw: 'Interac e-Transfer Received',
    merchantClean: 'Interac e-Transfer Received',
    amount: 3396,
    txnType: 'transfer',
  };
  assert.equal(decideRetag(row, payers, OWNER_NAMES), false);
});

test('decideRetag: an own-name direct deposit stays a transfer even when a payer set exists', () => {
  const payers = new Set(['cdg labs inc']);
  const row = { ...OWN_NAME_DEPOSIT, txnType: 'transfer' };
  assert.equal(decideRetag(row, payers, OWNER_NAMES), false);
});

test('decideRetag: strict-reuse — a direct deposit the heuristic itself tags income, with an empty payer set', () => {
  const row = {
    merchantRaw: 'Direct deposit from ADAMS GREENE HOLDINGS',
    merchantClean: 'Direct deposit from ADAMS GREENE HOLDINGS',
    amount: 42672,
    txnType: 'transfer',
  };
  assert.equal(decideRetag(row, new Set<string>(), OWNER_NAMES), true);
});

test('decideRetag: a negative amount is never income', () => {
  const payers = new Set(['cdg labs inc']);
  const row = {
    merchantRaw: 'Misc Payment CDG LABS INC',
    merchantClean: '',
    amount: -10,
    txnType: 'purchase',
  };
  assert.equal(decideRetag(row, payers, OWNER_NAMES), false);
});

test('decideRetag: rows already tagged income are left alone', () => {
  const payers = new Set(['cdg labs inc']);
  const row = { ...INCOME_ANCHOR, txnType: 'income' };
  assert.equal(decideRetag(row, payers, OWNER_NAMES), false);
});

test('decideRetag: an ineligible type (purchase) is not touched even with a payer match', () => {
  const payers = new Set(['cdg labs inc']);
  const row = {
    merchantRaw: 'Misc Payment CDG LABS INC',
    merchantClean: '',
    amount: 7000,
    txnType: 'purchase',
  };
  assert.equal(decideRetag(row, payers, OWNER_NAMES), false);
});

test('normalizePayer: extracts the payer after "direct deposit from"', () => {
  assert.equal(normalizePayer('Direct deposit from CDG LABS INC', ''), 'cdg labs inc');
});

test('normalizePayer: returns null for non-direct-deposit narration', () => {
  assert.equal(normalizePayer('Misc Payment CDG LABS INC', ''), null);
});

test('normalizePayer: returns null for a single-token payer (min-2-token guard)', () => {
  assert.equal(normalizePayer('Direct deposit from BOB', ''), null);
});
