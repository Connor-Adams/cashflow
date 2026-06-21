import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../../db';
import { Account, Entity, Household, ShareholderLoan, Transaction } from '../../models';
import { computeShareholderLoanBalance } from './shareholderLoanBalance';

beforeEach(async () => { await sequelize.sync({ force: true }); });

test('balance = manual ledger + classified loan transfers', async () => {
  const household = await Household.create({ name: 'L' });
  const corp = await Entity.create({
    householdId: household.id, kind: 'corp', legalName: 'Corp',
    jurisdiction: 'CA-ON', fiscalYearEnd: '12-31',
  } as never);
  const acct = await Account.create({
    name: 'Corp', householdId: household.id, accountType: 'checking',
    entityId: corp.id, taxStatus: 'non_registered', defaultCurrency: 'CAD',
  } as never);
  // manual: advance 10000, repayment 2000 → +8000
  await ShareholderLoan.create({ entityId: corp.id, date: '2025-01-01', kind: 'advance', amount: '10000.0000' } as never);
  await ShareholderLoan.create({ entityId: corp.id, date: '2025-02-01', kind: 'repayment', amount: '2000.0000' } as never);
  // classified transfers: loan_advance 3000 (corp outflow), loan_repayment 1000 (corp inflow) → +2000
  await Transaction.create({
    accountId: acct.id, householdId: household.id, entityId: corp.id,
    date: '2025-03-01', amount: '-3000.0000', currency: 'CAD', merchantRaw: 'O', merchantClean: 'O',
    taxTreatmentOverride: 'loan_advance', importBatch: 's', sourceRowFingerprint: 'fp-l1', sourceIdentityFingerprint: 'sif-l1',
  } as never);
  await Transaction.create({
    accountId: acct.id, householdId: household.id, entityId: corp.id,
    date: '2025-04-01', amount: '1000.0000', currency: 'CAD', merchantRaw: 'O', merchantClean: 'O',
    taxTreatmentOverride: 'loan_repayment', importBatch: 's', sourceRowFingerprint: 'fp-l2', sourceIdentityFingerprint: 'sif-l2',
  } as never);

  const balance = await computeShareholderLoanBalance(corp.id);
  assert.equal(balance.toFixed(2), '10000.00'); // 8000 + 2000
});
