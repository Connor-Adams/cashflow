/**
 * The nightly enrichment backfill re-derives txnType for review-flagged rows.
 * Without the account's entity it read "Direct deposit from CDG LABS INC" on the
 * company's own chequing as external income, and flipped five internal moves
 * back to income every night (prod 2867, 2869, 11614, 11615, 12009).
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { Account, Entity, Household, HouseholdMember, Transaction, User, sequelize } from '../models';
import { runBackfill, type BackfillFlags } from './runEnrichmentBackfill';

let HH: number;
let corpChequing: number;
let personal: number;

before(async () => {
  await sequelize.sync({ force: true });
  HH = (await Household.create({ name: 'E' } as never)).id;
  const user = await User.create({
    email: 'e@example.com', displayName: 'Connor Adams', passwordHash: 'x', passwordSalt: 'x', passwordParams: '{}',
  } as never);
  await HouseholdMember.create({ householdId: HH, userId: user.id, role: 'owner' } as never);
  const me = await Entity.create({ householdId: HH, kind: 'personal', legalName: 'Personal' } as never);
  const corp = await Entity.create({ householdId: HH, kind: 'corp', legalName: 'CDG LABS INC.', ownerEntityId: me.id } as never);
  corpChequing = (await Account.create({ name: 'Corp Chequing', householdId: HH, entityId: corp.id } as never)).id;
  personal = (await Account.create({ name: 'Chequing', householdId: HH, entityId: me.id } as never)).id;
});

const flags: BackfillFlags = {
  dryRun: false, noReviewFlag: false, reviewOnly: true, verbose: false,
  accountId: null, householdId: null, limit: null, batchSize: 100, dateFrom: null, dateTo: null,
};

test('the nightly backfill types a company\'s own deposit as transfer, and salary to the owner as income', async () => {
  const mk = (accountId: number, txnType: string, n: number) => Transaction.create({
    accountId, householdId: HH, importBatch: 'e', date: '2026-05-27',
    merchantRaw: 'Direct deposit from CDG LABS INC', merchantClean: 'Direct deposit from CDG LABS INC',
    amount: '3435.50', currency: 'CAD', txnType, reviewFlag: true,
    sourceRowFingerprint: `fp-e-${n}`, sourceIdentityFingerprint: `sif-e-${n}`,
  } as never);
  const internal = await mk(corpChequing, 'income', 1);
  const salary = await mk(personal, 'transfer', 2);

  await runBackfill({ ...flags, householdId: HH });

  assert.equal((await Transaction.findByPk(internal.id))!.txnType, 'transfer');
  assert.equal((await Transaction.findByPk(salary.id))!.txnType, 'income');
});
