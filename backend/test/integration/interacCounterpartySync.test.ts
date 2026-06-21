/**
 * Integration tests for runInteracCounterpartySync (Task 4).
 *
 * All Gmail I/O is stubbed via the `fetchEmails` option so no real network
 * call is made. The harness mirrors counterpartyBackfill.test.ts.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { seedHousehold } from '../helpers/seedHousehold.js';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';
import type { InteracEmailLite } from '../../src/import/matchInteracCounterparty.js';

let householdAId: number;
let userAId: number;
let testDb: PgTestDb;
let ownerDisplayName: string;

async function makeAccount(opts: {
  householdId: number;
  userId: number;
  name: string;
  accountType: string;
}): Promise<number> {
  const models = await import('../../src/models');
  const acc = await models.Account.create({
    name: opts.name,
    owner: 'me',
    householdId: opts.householdId,
    ownerUserId: opts.userId,
    accountType: opts.accountType,
    defaultCurrency: 'CAD',
    openingBalance: '0',
    openingBalanceDate: null,
  } as never);
  return acc.id;
}

async function makeTxn(opts: {
  accountId: number;
  householdId: number;
  merchantRaw: string;
  amount: string;
  date: string;
}): Promise<number> {
  const models = await import('../../src/models');
  const fp = crypto.randomBytes(16).toString('hex');
  const row = await models.Transaction.create({
    accountId: opts.accountId,
    householdId: opts.householdId,
    visibility: 'shared',
    ownershipType: 'me',
    importBatch: 'interac-sync-test',
    date: opts.date,
    merchantRaw: opts.merchantRaw,
    merchantClean: opts.merchantRaw,
    amount: opts.amount,
    currency: 'CAD',
    notes: null,
    sourceReference: null,
    sourceRowFingerprint: fp,
    sourceIdentityFingerprint: fp,
    counterpartyRaw: null,
    counterpartyContactId: null,
  } as never);
  return row.id;
}

async function wipeState(): Promise<void> {
  const models = await import('../../src/models');
  await models.AiSuggestion.destroy({ where: {}, force: true });
  await models.ProviderJobLog.destroy({ where: {}, force: true });
  await models.Transaction.destroy({ where: {}, force: true });
  await models.Account.destroy({ where: {}, force: true });
  await models.Contact.destroy({ where: {}, force: true });
}

before(async () => {
  testDb = await setupPgTestDb('interac_counterparty_sync');
  // Bootstrap superadmin (first registered user).
  const { default: app } = await import('../../src/app.js');
  const request = (await import('supertest')).default;
  const bootstrap = request.agent(app);
  const reg = await bootstrap.post('/api/auth/register').send({
    email: 'boot-ics@example.com',
    displayName: 'Boot ICS',
    password: 'password123',
  });
  assert.equal(reg.status, 201);

  const seedA = await seedHousehold('icsA', 'ICS User A');
  householdAId = seedA.householdId;
  userAId = seedA.userId;

  // Look up the seeded user's displayName.
  const models = await import('../../src/models');
  const u = await models.User.findByPk(userAId);
  ownerDisplayName = u!.displayName;
});

after(async () => {
  await teardownPgTestDb(testDb);
});

beforeEach(async () => {
  await wipeState();
});

// ---------------------------------------------------------------------------
// Test: auto-apply + contact creation
// ---------------------------------------------------------------------------

test('auto-apply: nameless Interac Out txn gets counterpartyRaw + Contact', async () => {
  const { runInteracCounterpartySync } = await import('../../src/integrations/interacCounterparty.js');

  const accId = await makeAccount({ householdId: householdAId, userId: userAId, name: 'Chk', accountType: 'checking' });
  const txnId = await makeTxn({
    accountId: accId, householdId: householdAId,
    merchantRaw: 'Interac e-Transfer® Out', amount: '-5000.0000', date: '2025-06-04',
  });

  const stubEmails: InteracEmailLite[] = [
    { name: 'Stephen Masseur', amountCents: 500000, direction: 'sent', ref: 'R1', emailDate: '2025-06-04', messageId: 'm1' },
  ];

  await runInteracCounterpartySync({
    householdId: householdAId,
    userId: userAId,
    fetchEmails: async () => stubEmails,
  });

  const models = await import('../../src/models');
  const txn = await models.Transaction.findByPk(txnId);
  assert.equal(txn!.counterpartyRaw, 'Stephen Masseur', 'counterpartyRaw set');
  assert.ok(txn!.counterpartyContactId, 'counterpartyContactId linked');

  const contact = await models.Contact.findByPk(txn!.counterpartyContactId!);
  assert.equal(contact!.normalizedName, 'stephen masseur', 'Contact normalizedName correct');
});

// ---------------------------------------------------------------------------
// Test: self → raw only, no contact
// ---------------------------------------------------------------------------

test('self-transfer: txn gets counterpartyRaw=ownerName but no Contact', async () => {
  const { runInteracCounterpartySync } = await import('../../src/integrations/interacCounterparty.js');

  const accId = await makeAccount({ householdId: householdAId, userId: userAId, name: 'Chk2', accountType: 'checking' });
  const txnId = await makeTxn({
    accountId: accId, householdId: householdAId,
    merchantRaw: 'Interac e-Transfer® Received', amount: '+1000.0000', date: '2025-07-15',
  });

  const stubEmails: InteracEmailLite[] = [
    { name: ownerDisplayName, amountCents: 100000, direction: 'sent', ref: 'R2', emailDate: '2025-07-15', messageId: 'm2' },
  ];

  await runInteracCounterpartySync({
    householdId: householdAId,
    userId: userAId,
    fetchEmails: async () => stubEmails,
  });

  const models = await import('../../src/models');
  const txn = await models.Transaction.findByPk(txnId);
  assert.equal(txn!.counterpartyRaw, ownerDisplayName, 'counterpartyRaw = ownerDisplayName');
  assert.equal(txn!.counterpartyContactId, null, 'no Contact for self-transfer');
});

// ---------------------------------------------------------------------------
// Test: collision → ai_suggestions (review)
// ---------------------------------------------------------------------------

test('collision: two same-amount/same-week txns get ai_suggestions, not auto-applied', async () => {
  const { runInteracCounterpartySync } = await import('../../src/integrations/interacCounterparty.js');

  const accId = await makeAccount({ householdId: householdAId, userId: userAId, name: 'Chk3', accountType: 'checking' });
  const txnId1 = await makeTxn({
    accountId: accId, householdId: householdAId,
    merchantRaw: 'Interac e-Transfer® Out', amount: '-5000.0000', date: '2025-08-01',
  });
  const txnId2 = await makeTxn({
    accountId: accId, householdId: householdAId,
    merchantRaw: 'Interac e-Transfer® Out', amount: '-5000.0000', date: '2025-08-02',
  });

  const stubEmails: InteracEmailLite[] = [
    { name: 'A', amountCents: 500000, direction: 'sent', ref: 'Ra', emailDate: '2025-08-01', messageId: 'ma' },
    { name: 'B', amountCents: 500000, direction: 'sent', ref: 'Rb', emailDate: '2025-08-02', messageId: 'mb' },
  ];

  await runInteracCounterpartySync({
    householdId: householdAId,
    userId: userAId,
    fetchEmails: async () => stubEmails,
  });

  const models = await import('../../src/models');
  // No auto-apply on collisions.
  const txn1 = await models.Transaction.findByPk(txnId1);
  const txn2 = await models.Transaction.findByPk(txnId2);
  assert.equal(txn1!.counterpartyContactId, null, 'txn1 not auto-linked');
  assert.equal(txn2!.counterpartyContactId, null, 'txn2 not auto-linked');

  // Two ai_suggestions created.
  const suggestions = await models.AiSuggestion.findAll({
    where: { householdId: householdAId, kind: 'counterparty_email_match', status: 'suggested' },
  });
  assert.equal(suggestions.length, 2, 'two suggestions for collision pair');
});

// ---------------------------------------------------------------------------
// Test: idempotent
// ---------------------------------------------------------------------------

test('idempotent: running auto-apply twice does not duplicate Contact or change link', async () => {
  const { runInteracCounterpartySync } = await import('../../src/integrations/interacCounterparty.js');

  const accId = await makeAccount({ householdId: householdAId, userId: userAId, name: 'Chk4', accountType: 'checking' });
  const txnId = await makeTxn({
    accountId: accId, householdId: householdAId,
    merchantRaw: 'Interac e-Transfer® Out', amount: '-5000.0000', date: '2025-06-04',
  });

  const stubEmails: InteracEmailLite[] = [
    { name: 'Stephen Masseur', amountCents: 500000, direction: 'sent', ref: 'R1', emailDate: '2025-06-04', messageId: 'm1' },
  ];

  await runInteracCounterpartySync({
    householdId: householdAId,
    userId: userAId,
    fetchEmails: async () => stubEmails,
  });

  const models = await import('../../src/models');
  const txnAfterFirst = await models.Transaction.findByPk(txnId);
  const contactIdAfterFirst = txnAfterFirst!.counterpartyContactId;
  assert.ok(contactIdAfterFirst, 'linked after first run');

  // Second run.
  await runInteracCounterpartySync({
    householdId: householdAId,
    userId: userAId,
    fetchEmails: async () => stubEmails,
  });

  const txnAfterSecond = await models.Transaction.findByPk(txnId);
  assert.equal(txnAfterSecond!.counterpartyContactId, contactIdAfterFirst, 'contact link unchanged');

  const count = await models.Contact.count({
    where: { householdId: householdAId, normalizedName: 'stephen masseur' },
  });
  assert.equal(count, 1, 'no duplicate Contact');
});

// ---------------------------------------------------------------------------
// Test: dryRun writes nothing
// ---------------------------------------------------------------------------

test('dryRun: nothing written — txn stays null, no Contact, no ProviderJobLog', async () => {
  const { runInteracCounterpartySync } = await import('../../src/integrations/interacCounterparty.js');

  const accId = await makeAccount({ householdId: householdAId, userId: userAId, name: 'Chk5', accountType: 'checking' });
  const txnId = await makeTxn({
    accountId: accId, householdId: householdAId,
    merchantRaw: 'Interac e-Transfer® Out', amount: '-5000.0000', date: '2025-06-04',
  });

  const stubEmails: InteracEmailLite[] = [
    { name: 'Stephen Masseur', amountCents: 500000, direction: 'sent', ref: 'R1', emailDate: '2025-06-04', messageId: 'm1' },
  ];

  const result = await runInteracCounterpartySync({
    householdId: householdAId,
    userId: userAId,
    dryRun: true,
    fetchEmails: async () => stubEmails,
  });

  assert.equal(result.dryRun, true);

  const models = await import('../../src/models');
  const txn = await models.Transaction.findByPk(txnId);
  assert.equal(txn!.counterpartyRaw, null, 'dryRun: counterpartyRaw stays null');
  assert.equal(txn!.counterpartyContactId, null, 'dryRun: no Contact linked');

  const contacts = await models.Contact.count({ where: { householdId: householdAId } });
  assert.equal(contacts, 0, 'dryRun: no Contact created');

  const logs = await models.ProviderJobLog.count({ where: { provider: 'interac_counterparty_sync' } });
  assert.equal(logs, 0, 'dryRun: no ProviderJobLog written');
});

// ---------------------------------------------------------------------------
// Test: ProviderJobLog written on non-dry run
// ---------------------------------------------------------------------------

test('ProviderJobLog: non-dry run writes a row with provider=interac_counterparty_sync', async () => {
  const { runInteracCounterpartySync, INTERAC_SYNC_PROVIDER } = await import('../../src/integrations/interacCounterparty.js');

  const accId = await makeAccount({ householdId: householdAId, userId: userAId, name: 'Chk6', accountType: 'checking' });
  await makeTxn({
    accountId: accId, householdId: householdAId,
    merchantRaw: 'Interac e-Transfer® Out', amount: '-5000.0000', date: '2025-06-04',
  });

  await runInteracCounterpartySync({
    householdId: householdAId,
    userId: userAId,
    fetchEmails: async () => [],
  });

  const models = await import('../../src/models');
  const log = await models.ProviderJobLog.findOne({
    where: { provider: INTERAC_SYNC_PROVIDER, symbol: String(householdAId) },
  });
  assert.ok(log, 'ProviderJobLog row created');
  assert.equal(log!.provider, 'interac_counterparty_sync');
});
