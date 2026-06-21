import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize, ReceiptSenderAllowlist, Household } from './index';

let householdId: number;

before(async () => {
  await sequelize.sync({ force: true });
});

beforeEach(async () => {
  await ReceiptSenderAllowlist.destroy({ where: {}, truncate: true });
  await Household.destroy({ where: {}, truncate: true });
  householdId = (await Household.create({ name: 'Test Household' })).id;
});

test('new discovery columns default correctly', async () => {
  const row = await ReceiptSenderAllowlist.create({
    householdId,
    emailAddress: 'shop@example.com',
  });
  assert.equal(row.status, 'enabled');
  assert.equal(row.source, 'user');
  assert.equal(row.candidateCount, 0);
  assert.equal(row.sampleSubject, null);
  assert.equal(row.lastSeenAt, null);
});

test('a suggested row persists its discovery fields', async () => {
  const row = await ReceiptSenderAllowlist.create({
    householdId,
    emailAddress: 'invoices@vendor.test',
    status: 'suggested',
    source: 'discovery',
    sampleSubject: 'Your receipt',
    candidateCount: 3,
    lastSeenAt: new Date(),
  });
  const reloaded = await ReceiptSenderAllowlist.findByPk(row.id);
  assert.equal(reloaded?.status, 'suggested');
  assert.equal(reloaded?.candidateCount, 3);
});
