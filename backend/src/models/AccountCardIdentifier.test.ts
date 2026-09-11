import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  sequelize,
  Household,
  Account,
  AccountCardIdentifier,
} from './index';
import { upsertAccountCardIdentifier } from './AccountCardIdentifier';

let householdId: number;
let accountId: number;
let otherAccountId: number;

before(async () => {
  await sequelize.sync({ force: true });
});

beforeEach(async () => {
  await AccountCardIdentifier.destroy({ where: {}, truncate: true, force: true });
  await Account.destroy({ where: {}, truncate: true, force: true });
  await Household.destroy({ where: {}, truncate: true });
  const household = await Household.create({ name: 'Test Household' });
  householdId = household.id;
  const account = await Account.create({
    name: 'Costco MC',
    owner: 'test',
    householdId,
    shortCode: 'costco',
  } as never);
  accountId = account.id;
  const otherAccount = await Account.create({
    name: 'Amex Reserve',
    owner: 'test',
    householdId,
    shortCode: '701001',
  } as never);
  otherAccountId = otherAccount.id;
});

test('creates an identifier row with the expected fields', async () => {
  const row = await AccountCardIdentifier.create({
    householdId,
    accountId,
    last4: '3114',
    source: 'costco_till_receipt-pdf',
    firstSeenAt: new Date('2026-01-01'),
    lastSeenAt: new Date('2026-01-01'),
  });
  assert.equal(row.last4, '3114');
  assert.equal(row.accountId, accountId);
  assert.equal(row.source, 'costco_till_receipt-pdf');
});

test('rejects a non-4-digit last4', async () => {
  await assert.rejects(
    AccountCardIdentifier.create({
      householdId,
      accountId,
      last4: 'costco',
      source: 'costco_till_receipt-pdf',
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
    }),
  );
  await assert.rejects(
    AccountCardIdentifier.create({
      householdId,
      accountId,
      last4: '31',
      source: 'costco_till_receipt-pdf',
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
    }),
  );
});

test('(account_id, last4) is unique at the DB layer', async () => {
  await AccountCardIdentifier.create({
    householdId,
    accountId,
    last4: '3114',
    source: 'costco_till_receipt-pdf',
    firstSeenAt: new Date(),
    lastSeenAt: new Date(),
  });
  await assert.rejects(
    AccountCardIdentifier.create({
      householdId,
      accountId,
      last4: '3114',
      source: 'receipt_tender',
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
    }),
  );
});

test('a last4 shared by two accounts produces two rows', async () => {
  await AccountCardIdentifier.create({
    householdId,
    accountId,
    last4: '1234',
    source: 'pdf_statement_header',
    firstSeenAt: new Date(),
    lastSeenAt: new Date(),
  });
  await AccountCardIdentifier.create({
    householdId,
    accountId: otherAccountId,
    last4: '1234',
    source: 'pdf_statement_header',
    firstSeenAt: new Date(),
    lastSeenAt: new Date(),
  });
  const rows = await AccountCardIdentifier.findAll({ where: { last4: '1234' } });
  assert.equal(rows.length, 2);
});

test('upsertAccountCardIdentifier is idempotent and refreshes last_seen_at', async () => {
  const first = await upsertAccountCardIdentifier({
    householdId,
    accountId,
    last4: '3114',
    source: 'costco_till_receipt-pdf',
    seenAt: new Date('2026-01-01T00:00:00Z'),
  });
  const firstSeenAt = first.firstSeenAt;

  const second = await upsertAccountCardIdentifier({
    householdId,
    accountId,
    last4: '3114',
    source: 'costco_till_receipt-pdf',
    seenAt: new Date('2026-02-01T00:00:00Z'),
  });

  const rows = await AccountCardIdentifier.findAll({
    where: { accountId, last4: '3114' },
  });
  assert.equal(rows.length, 1, 'must not duplicate on a repeat sighting');
  assert.equal(second.id, first.id);
  assert.deepEqual(second.firstSeenAt, firstSeenAt, 'first_seen_at must not move');
  assert.equal(
    second.lastSeenAt.toISOString(),
    new Date('2026-02-01T00:00:00Z').toISOString(),
  );
});

test('upsertAccountCardIdentifier rejects a non-4-digit last4', async () => {
  await assert.rejects(
    upsertAccountCardIdentifier({
      householdId,
      accountId,
      last4: 'costco',
      source: 'costco_till_receipt-pdf',
    }),
  );
});
