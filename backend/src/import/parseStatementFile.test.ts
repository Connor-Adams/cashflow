/**
 * Preview duplicate-detection key — dialect-stable amount normalization.
 *
 * Bug: `markDuplicates` built the lookup key for incoming rows from a JS
 * number (`String(-123.45)` → '-123.45') but the key for existing rows from
 * the model attribute. `Transaction.amount` is DECIMAL(14,4) declared as
 * string; Postgres returns numerics padded to the typmod scale
 * ('-123.4500'), so the Map lookup never matched and every transaction's
 * `duplicate` flag (and preview.duplicateCounts.transactions) was 0 in
 * production. SQLite's numeric affinity returns -123.45, which is why tests
 * passed. The key must coerce through Number() so both representations
 * collapse to the same string.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { txnDupKey } from './parseStatementFile';
import { sequelize, Account, Household } from '../models';

const base = { date: '2026-05-01', currency: 'CAD', merchantRaw: 'PIZZAVILLE #118' };

test('pg-padded numeric string and JS number produce the same dup key', () => {
  const incoming = txnDupKey({ ...base, amount: -123.45 });
  const existingPg = txnDupKey({ ...base, amount: '-123.4500' });
  assert.equal(existingPg, incoming);
});

test('sqlite number round-trip still matches', () => {
  const incoming = txnDupKey({ ...base, amount: -123.45 });
  const existingSqlite = txnDupKey({ ...base, amount: -123.45 });
  assert.equal(existingSqlite, incoming);
});

test('unpadded string (pre-coercion call sites) matches the number form', () => {
  assert.equal(
    txnDupKey({ ...base, amount: '-123.45' }),
    txnDupKey({ ...base, amount: -123.45 }),
  );
});

test('integer amounts match their padded form', () => {
  assert.equal(
    txnDupKey({ ...base, amount: '50.0000' }),
    txnDupKey({ ...base, amount: 50 }),
  );
});

test('different amounts still produce different keys', () => {
  assert.notEqual(
    txnDupKey({ ...base, amount: '-123.4600' }),
    txnDupKey({ ...base, amount: -123.45 }),
  );
});

test('investment account: zero-CAD WS crypto rows create InvestmentActivity but no Transaction', async () => {
  await sequelize.sync({ force: true });
  const hh = await Household.create({ name: 'H' } as never);
  const account = await Account.create({
    householdId: hh.id,
    name: 'WS Crypto',
    accountType: 'investment',
    owner: 'me',
    visibility: 'private',
    defaultCurrency: 'CAD',
    shortCode: 'CRYPTO01',
  } as never);

  const { parseStatementFile } = await import('./parseStatementFile');

  // WS monthly crypto CSV: one staking reward (amount=0) + one real buy (amount<>0)
  const csv = [
    'date,transaction,description,amount,balance,currency',
    '2025-01-06,CRYPTORWD,0.0000544651 of ETH rewards earned,0,0,CAD',
    '2025-01-06,BUY,Purchase of 1.5 DOT (executed at 2025-01-06),-12.00,0,CAD',
  ].join('\n');

  const preview = await parseStatementFile({
    buffer: Buffer.from(csv),
    fileName: 'WS-Crypto-2025-01-01-monthly-statement-transactions.csv',
    accountId: account.id,
    householdId: hh.id,
  });

  assert.ok(!('ok' in preview && preview.ok === false), 'should not error');
  const p = preview as { transactions: Array<{ amount: number }>; investmentActivities: Array<{ activityType: string }> };

  // reward → activity only, no transaction
  assert.ok(
    p.investmentActivities.some((a) => a.activityType === 'staking_reward'),
    'expected a staking_reward InvestmentActivity',
  );
  assert.ok(
    !p.transactions.some((t) => t.amount === 0),
    'expected no zero-amount Transaction for the staking reward',
  );
  // real buy still produces a transaction
  assert.ok(
    p.transactions.some((t) => t.amount === -12),
    'expected a Transaction for the -12 buy',
  );
});
