import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Account, Entity, Household, HouseholdMember, Transaction, TransactionRevision, User, sequelize } from '../models';
import { BackfillAborted } from '../transfers/backfillHalfLinkedCsvTransfers';
import { applyEntityFlowRetypes, retypeTarget, scanEntityFlowRetypes } from './retypeEntityFlows';

test('retypeTarget: only the two entity transitions', () => {
  assert.equal(retypeTarget('income', 'transfer'), 'transfer');
  assert.equal(retypeTarget('unknown', 'transfer'), 'transfer');
  assert.equal(retypeTarget('transfer', 'income'), 'income');
  assert.equal(retypeTarget('unknown', 'income'), 'income');
  assert.equal(retypeTarget('payment', 'income'), null, 'a narrative-typed payment is left alone');
  assert.equal(retypeTarget('transfer', 'transfer'), null);
  assert.equal(retypeTarget('income', null), null);
});

let HH: number;
let corpChequing: number;
let corpWiseUsd: number;
let personal: number;
let seq = 0;

beforeEach(async () => {
  await sequelize.sync({ force: true });
  HH = (await Household.create({ name: 'T' })).id;
  const user = await User.create({
    email: 'o@example.com', displayName: 'Connor Adams', passwordHash: 'x', passwordSalt: 'x', passwordParams: '{}',
  } as never);
  await HouseholdMember.create({ householdId: HH, userId: user.id, role: 'owner' } as never);
  const me = await Entity.create({ householdId: HH, kind: 'personal', legalName: 'Personal' } as never);
  const corp = await Entity.create({ householdId: HH, kind: 'corp', legalName: 'CDG LABS INC.', ownerEntityId: me.id } as never);
  corpChequing = (await Account.create({ name: 'WS Corporate Chequing', householdId: HH, entityId: corp.id, accountType: 'checking' } as never)).id;
  corpWiseUsd = (await Account.create({ name: 'Wise Corporate USD', householdId: HH, entityId: corp.id, accountType: 'checking', defaultCurrency: 'USD' } as never)).id;
  personal = (await Account.create({ name: 'WS Chequing', householdId: HH, entityId: me.id, accountType: 'checking' } as never)).id;
});

async function txn(accountId: number, merchantRaw: string, amount: number, txnType: string): Promise<Transaction> {
  seq += 1;
  return Transaction.create({
    accountId, householdId: HH, visibility: 'private', ownershipType: 'me', importBatch: 'b', date: '2026-05-27',
    merchantRaw, merchantClean: merchantRaw, amount: String(amount), currency: 'CAD', txnType, reviewFlag: false,
    sourceRowFingerprint: `r-${seq}`, sourceIdentityFingerprint: `i-${seq}`,
  } as never);
}

async function seed() {
  return {
    internal: await txn(corpChequing, 'Direct deposit from CDG LABS INC', 20443.54, 'income'),
    client: await txn(corpWiseUsd, 'Received money from WANDERCOM with reference X', 5000, 'transfer'),
    salary: await txn(personal, 'Direct deposit from CDG LABS INC', 3000, 'income'),
    owner: await txn(corpWiseUsd, 'Received money from Connor Adams', 1000, 'transfer'),
    alreadyIncome: await txn(corpWiseUsd, 'Received money from AURELIUS TECHNOL', 700, 'income'),
  };
}

test('scan: re-types the corp\'s own move and the client receipt, nothing else', async () => {
  const s = await seed();
  const due = await scanEntityFlowRetypes();
  assert.deepEqual(
    due.map((r) => [r.id, r.from, r.to]).sort(),
    [[s.internal.id, 'income', 'transfer'], [s.client.id, 'transfer', 'income']].sort(),
  );
});

test('apply: writes both, records a revision each, leaves salary and owner funding alone', async () => {
  const s = await seed();
  const { retyped } = await applyEntityFlowRetypes({ expect: 2 });
  assert.equal(retyped, 2);
  assert.equal((await Transaction.findByPk(s.internal.id))!.txnType, 'transfer');
  assert.equal((await Transaction.findByPk(s.client.id))!.txnType, 'income');
  assert.equal((await Transaction.findByPk(s.salary.id))!.txnType, 'income', 'salary into a personal account stays income');
  assert.equal((await Transaction.findByPk(s.owner.id))!.txnType, 'transfer', 'owner funding is not revenue');
  assert.equal(await TransactionRevision.count({ where: { transactionId: [s.internal.id, s.client.id] } }), 2);
  assert.equal((await scanEntityFlowRetypes()).length, 0, 'idempotent');
});

test('apply: an --expect mismatch writes nothing', async () => {
  const s = await seed();
  await assert.rejects(applyEntityFlowRetypes({ expect: 34 }), BackfillAborted);
  assert.equal((await Transaction.findByPk(s.internal.id))!.txnType, 'income');
});
