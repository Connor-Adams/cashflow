import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize, ReceiptSenderAllowlist, Household } from '../models';
import {
  parseEmailAddress,
  upsertSenderSuggestion,
  listSenderSuggestions,
  promoteSuggestion,
  dismissSuggestion,
} from './receiptSenderSuggestions';

before(async () => {
  await sequelize.sync({ force: true });
  await Household.create({ id: 1, name: 'Test Household' });
});
beforeEach(async () => {
  await ReceiptSenderAllowlist.destroy({ where: {} });
});

test('parseEmailAddress pulls the bare lowercased address', () => {
  assert.equal(parseEmailAddress('Foo Bar <Bar@Baz.com>'), 'bar@baz.com');
  assert.equal(parseEmailAddress('plain@addr.com'), 'plain@addr.com');
  assert.equal(parseEmailAddress(null), null);
  assert.equal(parseEmailAddress('no address here'), null);
});

test('upsert creates then increments a suggestion', async () => {
  await upsertSenderSuggestion({ householdId: 1, fromAddr: 'Shop <s@shop.com>', subject: 'Receipt 1' });
  await upsertSenderSuggestion({ householdId: 1, fromAddr: 's@shop.com', subject: 'Receipt 2' });
  const list = await listSenderSuggestions(1);
  assert.equal(list.length, 1);
  assert.equal(list[0].emailAddress, 's@shop.com');
  assert.equal(list[0].candidateCount, 2);
  assert.equal(list[0].sampleSubject, 'Receipt 2');
});

test('upsert never resurrects a dismissed sender', async () => {
  await ReceiptSenderAllowlist.create({
    householdId: 1, emailAddress: 'no@thanks.com', status: 'dismissed', enabled: false,
  });
  await upsertSenderSuggestion({ householdId: 1, fromAddr: 'no@thanks.com', subject: 'Receipt' });
  const list = await listSenderSuggestions(1);
  assert.equal(list.length, 0);
});

test('promote and dismiss flip status', async () => {
  await upsertSenderSuggestion({ householdId: 1, fromAddr: 'a@a.com', subject: 'x' });
  await upsertSenderSuggestion({ householdId: 1, fromAddr: 'b@b.com', subject: 'y' });
  const [a, b] = await listSenderSuggestions(1);
  assert.equal(await promoteSuggestion({ householdId: 1, id: a.id }), true);
  assert.equal(await dismissSuggestion({ householdId: 1, id: b.id }), true);
  const remaining = await listSenderSuggestions(1);
  assert.equal(remaining.length, 0);
  const promoted = await ReceiptSenderAllowlist.findByPk(a.id);
  assert.equal(promoted?.status, 'enabled');
  assert.equal(promoted?.enabled, true);
});

test('promote returns false for a non-suggestion row', async () => {
  const row = await ReceiptSenderAllowlist.create({ householdId: 1, emailAddress: 'e@e.com' });
  assert.equal(await promoteSuggestion({ householdId: 1, id: row.id }), false);
});
