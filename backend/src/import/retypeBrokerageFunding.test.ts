import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Account, Household, Transaction, TransactionRevision, sequelize } from '../models';
import {
  RetypeAborted,
  applyBrokerageFundingRetype,
  scanBrokerageFundingRetype,
  shouldRetypeAsTransfer,
  summarizeBrokerageRetype,
} from './retypeBrokerageFunding';

// ─── Predicate ──────────────────────────────────────────────────────────────

test('re-types the historical Questrade contribution stored as a payment', () => {
  assert.equal(
    shouldRetypeAsTransfer({
      merchantRaw: 'ONLINE BANKING PAYMENT - 4503 QUESTRADE',
      merchantClean: 'ONLINE BANKING PAYMENT -',
      amount: -250,
      txnType: 'payment',
    }),
    true,
  );
});

test('leaves a genuine card payment alone', () => {
  assert.equal(
    shouldRetypeAsTransfer({
      merchantRaw: 'ONLINE BANKING PAYMENT - 1234 CIBC MASTERCARD',
      merchantClean: 'ONLINE BANKING PAYMENT -',
      amount: -900,
      txnType: 'payment',
    }),
    false,
  );
});

test('only rewrites payment rows: a purchase the detector calls transfer is not its business', () => {
  assert.equal(
    shouldRetypeAsTransfer({
      merchantRaw: 'Online transfer sent - 6113 Connor Adams',
      merchantClean: 'Online transfer sent',
      amount: -100,
      txnType: 'purchase',
    }),
    false,
  );
});

test('leaves a payment row that a different transfer rule matches', () => {
  // Prod: two Wealthsimple "From chequing account" rows are typed payment. The
  // detector calls them transfer via an older rule; this re-type is not about them.
  assert.equal(
    shouldRetypeAsTransfer({
      merchantRaw: 'From chequing account',
      merchantClean: 'From chequing account',
      amount: 500,
      txnType: 'payment',
    }),
    false,
  );
});

// ─── DB-backed ──────────────────────────────────────────────────────────────

let HH: number;
let chequing: number;
let seq = 0;

beforeEach(async () => {
  await sequelize.sync({ force: true });
  HH = (await Household.create({ name: 'T' })).id;
  chequing = (await Account.create({ name: 'RBC', householdId: HH, accountType: 'checking' } as never)).id;
});

async function txn(merchantRaw: string, amount: string, txnType: string): Promise<Transaction> {
  seq += 1;
  return Transaction.create({
    sourceRowFingerprint: `row-${seq}`,
    sourceIdentityFingerprint: `identity-${seq}`,
    householdId: HH,
    accountId: chequing,
    importBatch: 'rbc-6985',
    visibility: 'private',
    ownershipType: 'me',
    date: '2023-09-25',
    merchantRaw,
    merchantClean: merchantRaw,
    amount,
    currency: 'CAD',
    reviewFlag: false,
    txnType,
  } as never);
}

async function seed() {
  const a = await txn('ONLINE BANKING PAYMENT - 4503 QUESTRADE', '-250.00', 'payment');
  const b = await txn('ONLINE BANKING PAYMENT - 3970 QUESTRADE', '-250.00', 'payment');
  const c = await txn('MISC PAYMENT QUESTRADE', '1819.40', 'payment');
  const card = await txn('ONLINE BANKING PAYMENT - 1234 CIBC MASTERCARD', '-900.00', 'payment');
  await txn('From chequing account', '500.00', 'payment');
  return { a, b, c, card };
}

test('scan + summary: Questrade payments grouped by narrative and account', async () => {
  const { a, b, c } = await seed();
  const rows = await scanBrokerageFundingRetype();
  assert.deepEqual(rows.map((r) => r.id), [a.id, b.id, c.id]);
  assert.deepEqual(summarizeBrokerageRetype(rows), [
    { narrative: 'ONLINE BANKING PAYMENT - # QUESTRADE', accountId: chequing, count: 2 },
    { narrative: 'MISC PAYMENT QUESTRADE', accountId: chequing, count: 1 },
  ]);
});

test('apply: re-types to transfer row by row, with a revision each; card payment untouched', async () => {
  const { a, b, c, card } = await seed();
  const { retyped } = await applyBrokerageFundingRetype({ expect: 3 });
  assert.equal(retyped, 3);
  for (const t of [a, b, c]) {
    assert.equal((await Transaction.findByPk(t.id))!.txnType, 'transfer');
    const revisions = await TransactionRevision.findAll({ where: { transactionId: t.id } });
    assert.equal(revisions.length, 1, `row ${t.id} has a revision`);
  }
  assert.equal((await Transaction.findByPk(card.id))!.txnType, 'payment');
});

test('apply: a count that differs from --expect writes nothing', async () => {
  const { a } = await seed();
  await assert.rejects(applyBrokerageFundingRetype({ expect: 2 }), RetypeAborted);
  assert.equal((await Transaction.findByPk(a.id))!.txnType, 'payment');
  assert.equal(await TransactionRevision.count(), 0);
});
