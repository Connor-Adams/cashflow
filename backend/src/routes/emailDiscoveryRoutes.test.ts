import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize, ReceiptSenderAllowlist, Household } from '../models';
import {
  listSenderSuggestions,
  promoteSuggestion,
  dismissSuggestion,
} from '../integrations/receiptSenderSuggestions';

before(async () => {
  await sequelize.sync({ force: true });
});
beforeEach(async () => {
  await ReceiptSenderAllowlist.destroy({ where: {} });
  await Household.destroy({ where: {} });
});

test('suggestion service backs the approve endpoint contract', async () => {
  await Household.create({ id: 7, name: 'Test Household', currency: 'CAD' });
  const row = await ReceiptSenderAllowlist.create({
    householdId: 7, emailAddress: 's@s.com', status: 'suggested', source: 'discovery', enabled: false, candidateCount: 2,
  });
  const before = await listSenderSuggestions(7);
  assert.equal(before.length, 1);
  assert.equal(await promoteSuggestion({ householdId: 7, id: row.id }), true);
  assert.equal((await listSenderSuggestions(7)).length, 0);
});

test('cross-household promote/dismiss is rejected', async () => {
  await Household.create({ id: 7, name: 'Test Household', currency: 'CAD' });
  const row = await ReceiptSenderAllowlist.create({
    householdId: 7, emailAddress: 's@s.com', status: 'suggested', source: 'discovery', enabled: false,
  });
  assert.equal(await promoteSuggestion({ householdId: 99, id: row.id }), false);
  assert.equal(await dismissSuggestion({ householdId: 99, id: row.id }), false);
});
