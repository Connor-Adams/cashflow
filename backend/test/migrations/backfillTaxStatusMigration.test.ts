import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize } from 'sequelize';
import { sequelize } from '../../src/db';
import { Account, Household } from '../../src/models';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const migration = require('../../src/migrations/20260618000002-backfill-tax-status.js');

beforeEach(async () => {
  await sequelize.sync({ force: true });
});

test('backfills tax_status on investment accounts by name; leaves non-investment; idempotent', async () => {
  const hh = await Household.create({ name: 'H' });
  // hooks:false so tax_status stays at the historical 'n_a' default
  const fhsa = await Account.create({ name: 'Individual FHSA', householdId: hh.id, accountType: 'investment' } as never, { hooks: false });
  const margin = await Account.create({ name: 'Individual Margin', householdId: hh.id, accountType: 'investment' } as never, { hooks: false });
  const tfsa = await Account.create({ name: 'Wealthsimple TFSA', householdId: hh.id, accountType: 'investment' } as never, { hooks: false });
  const rdsp = await Account.create({ name: 'RBC RDSP', householdId: hh.id, accountType: 'investment' } as never, { hooks: false });
  const chq = await Account.create({ name: 'Chequing', householdId: hh.id, accountType: 'checking' } as never, { hooks: false });

  await migration.up(sequelize.getQueryInterface(), Sequelize);

  assert.equal((await Account.findByPk(fhsa.id))!.taxStatus, 'registered_fhsa');
  assert.equal((await Account.findByPk(margin.id))!.taxStatus, 'non_registered');
  assert.equal((await Account.findByPk(tfsa.id))!.taxStatus, 'registered_tfsa');
  assert.equal((await Account.findByPk(rdsp.id))!.taxStatus, 'registered_rdsp');
  assert.equal((await Account.findByPk(chq.id))!.taxStatus, 'n_a');

  // idempotent: a second run does not throw and does not change anything
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  assert.equal((await Account.findByPk(fhsa.id))!.taxStatus, 'registered_fhsa');
  assert.equal((await Account.findByPk(chq.id))!.taxStatus, 'n_a');
});
