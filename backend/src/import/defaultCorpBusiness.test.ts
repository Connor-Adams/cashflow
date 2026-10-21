import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  Account, Entity, Household, HouseholdMember, Transaction, TransactionRevision, TransactionSignal, User, sequelize,
} from '../models';
import { BackfillAborted } from '../transfers/backfillHalfLinkedCsvTransfers';
import { businessForAccount } from './enrichment/corpBusinessDefault';
import { applyCorpBusinessDefaults, scanCorpBusinessDefaults } from './defaultCorpBusiness';
import { importCsvFile } from './runImport';
import { runBackfill, type BackfillFlags } from './runEnrichmentBackfill';

test('businessForAccount: corp accounts are business, personal accounts keep the guess', () => {
  assert.equal(businessForAccount(false, true), true);
  assert.equal(businessForAccount(null, true), true);
  assert.equal(businessForAccount(false, false), false);
  assert.equal(businessForAccount(null, false), null);
});

let HH: number;
let corp: number;
let personal: number;
let seq = 0;

beforeEach(async () => {
  await sequelize.sync({ force: true });
  HH = (await Household.create({ name: 'B' })).id;
  const user = await User.create({
    email: 'b@example.com', displayName: 'Connor Adams', passwordHash: 'x', passwordSalt: 'x', passwordParams: '{}',
  } as never);
  await HouseholdMember.create({ householdId: HH, userId: user.id, role: 'owner' } as never);
  const me = await Entity.create({ householdId: HH, kind: 'personal', legalName: 'Personal' } as never);
  const co = await Entity.create({ householdId: HH, kind: 'corp', legalName: 'CDG LABS INC.', ownerEntityId: me.id } as never);
  corp = (await Account.create({ name: 'Wise Corporate USD', householdId: HH, entityId: co.id, accountType: 'checking' } as never)).id;
  personal = (await Account.create({ name: 'Chequing', householdId: HH, entityId: me.id, accountType: 'checking' } as never)).id;
});

async function txn(accountId: number, over: Record<string, unknown>): Promise<Transaction> {
  seq += 1;
  return Transaction.create({
    accountId, householdId: HH, visibility: 'private', ownershipType: 'me', importBatch: 'b', date: '2026-05-27',
    merchantRaw: 'Received money from WANDERCOM', merchantClean: 'Received money from WANDERCOM',
    amount: '5000', currency: 'USD', txnType: 'income', reviewFlag: false, autoBusiness: false,
    sourceRowFingerprint: `r-${seq}`, sourceIdentityFingerprint: `i-${seq}`,
    ...over,
  } as never);
}

test('re-flag: flags corp rows, never a per-row override or a personal row, with a revision each', async () => {
  const unflagged = await txn(corp, {});
  const nullFlag = await txn(corp, { autoBusiness: null, amount: '-12', txnType: 'fee', merchantRaw: 'Wise fee' });
  const overridden = await txn(corp, { businessOverride: false });
  const mine = await txn(personal, { merchantRaw: 'Coffee', amount: '-4', txnType: 'purchase' });

  assert.deepEqual((await scanCorpBusinessDefaults()).map((r) => r.id).sort(), [unflagged.id, nullFlag.id].sort());
  const { flagged } = await applyCorpBusinessDefaults({ expect: 2 });
  assert.equal(flagged, 2);

  assert.equal((await Transaction.findByPk(unflagged.id))!.finalBusiness, true);
  assert.equal((await Transaction.findByPk(nullFlag.id))!.finalBusiness, true);
  assert.equal((await Transaction.findByPk(overridden.id))!.finalBusiness, false, 'a person said not business');
  assert.equal((await Transaction.findByPk(mine.id))!.finalBusiness, false, 'personal account untouched');
  assert.equal(await TransactionRevision.count({ where: { transactionId: [unflagged.id, nullFlag.id] } }), 2);
  assert.equal((await scanCorpBusinessDefaults()).length, 0);
});

test('re-flag: refuses while the entity re-type is still pending', async () => {
  // Typed income but it is the corp's own move: flagging it would book it as business income.
  const internal = await txn(corp, { merchantRaw: 'Direct deposit from CDG LABS INC', merchantClean: 'Direct deposit from CDG LABS INC', currency: 'CAD' });
  await assert.rejects(applyCorpBusinessDefaults(), BackfillAborted);
  assert.equal((await Transaction.findByPk(internal.id))!.autoBusiness, false);
});

test('the nightly backfill keeps a corp row business despite an AI "not business" answer', async () => {
  const row = await txn(corp, { reviewFlag: true, autoBusiness: true, txnType: 'transfer' });
  // The preserved fallback signal the AI stage left behind.
  await TransactionSignal.create({
    transactionId: row.id, source: 'ai', confidence: 'medium',
    fields: { autoCategory: 'Transfer', autoBusiness: false }, rationale: 'a received payment',
  } as never);
  const flags: BackfillFlags = {
    dryRun: false, noReviewFlag: false, reviewOnly: true, verbose: false,
    accountId: null, householdId: HH, limit: null, batchSize: 100, dateFrom: null, dateTo: null,
  };
  await runBackfill(flags);
  const after = (await Transaction.findByPk(row.id))!;
  assert.equal(after.autoBusiness, true);
  assert.equal(after.finalBusiness, true);
});

test('a CSV import onto a corp account is business', async () => {
  const csv = ['Date,Description,Amount', '2026-05-27,Received money from WANDERCOM,5000'].join('\n');
  const result = await importCsvFile({
    buffer: Buffer.from(csv, 'utf8'), fileName: 'wise-usd.csv', profileId: 'generic_passthrough',
    accountId: corp, householdId: HH,
  });
  assert.equal((result as { inserted?: number }).inserted, 1, JSON.stringify(result));
  const row = (await Transaction.findOne({ where: { accountId: corp } }))!;
  assert.equal(row.finalBusiness, true);
  assert.equal(row.txnType, 'income');
});
