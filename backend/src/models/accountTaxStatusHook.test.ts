import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../db';
import { Account, Household } from './';

beforeEach(async () => {
  await sequelize.sync({ force: true });
});

test('investment account gets tax_status inferred from name on create', async () => {
  const hh = await Household.create({ name: 'H' });
  const fhsa = await Account.create({ name: 'Individual FHSA', householdId: hh.id, accountType: 'investment' } as never);
  assert.equal(fhsa.taxStatus, 'registered_fhsa');
  const margin = await Account.create({ name: 'Individual Margin', householdId: hh.id, accountType: 'investment' } as never);
  assert.equal(margin.taxStatus, 'non_registered');
});

test('non-investment account keeps the n_a default', async () => {
  const hh = await Household.create({ name: 'H' });
  const chq = await Account.create({ name: 'RBC Day to Day', householdId: hh.id, accountType: 'checking' } as never);
  assert.equal(chq.taxStatus, 'n_a');
});

test('an explicit tax_status is preserved (not overwritten by inference)', async () => {
  const hh = await Household.create({ name: 'H' });
  // name contains "rrsp" but an explicit status must win
  const acc = await Account.create(
    { name: 'Legacy RRSP rollover', householdId: hh.id, accountType: 'investment', taxStatus: 'non_registered' } as never,
  );
  assert.equal(acc.taxStatus, 'non_registered');
});
