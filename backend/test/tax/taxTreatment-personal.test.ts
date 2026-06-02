import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../../src/db';
import { Account, Entity, Household, Transaction } from '../../src/models';

async function seedPersonal() {
  const household = await Household.create({ name: 'TT' });
  const entity = await Entity.create({
    householdId: household.id, kind: 'personal', legalName: 'P',
    jurisdiction: 'CA-ON', fiscalYearEnd: null,
  } as never);
  const account = await Account.create({
    name: 'Chq', householdId: household.id, accountType: 'checking',
    entityId: entity.id, taxStatus: 'non_registered', defaultCurrency: 'CAD',
  } as never);
  return { household, entity, account };
}

beforeEach(async () => { await sequelize.sync({ force: true }); });

test('taxTreatment persists on a Transaction', async () => {
  const { household, entity, account } = await seedPersonal();
  const txn = await Transaction.create({
    accountId: account.id, householdId: household.id, entityId: entity.id,
    date: '2025-06-15', amount: '1000.0000', currency: 'CAD',
    merchantRaw: 'CORP', merchantClean: 'CORP', taxTreatment: 'salary',
    importBatch: 'seed', sourceRowFingerprint: 'fp-tt-1', sourceIdentityFingerprint: 'sif-tt-1',
  } as never);
  const reloaded = await Transaction.findByPk(txn.id);
  assert.equal(reloaded?.taxTreatment, 'salary');
});
