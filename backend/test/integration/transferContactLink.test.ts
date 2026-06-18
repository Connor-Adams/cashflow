import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';
import { seedHousehold } from '../helpers/seedHousehold';

let testDb: PgTestDb;
let householdId: number;

before(async () => {
  testDb = await setupPgTestDb('transfer-link');
  ({ householdId } = await seedHousehold('xferlink', 'Seed'));
});
after(async () => { await teardownPgTestDb(testDb); });

test('links unambiguous transfers and reports ambiguous ones', async () => {
  const { Account, Contact, Transaction } = await import('../../src/models');
  const { runTransferContactLink, _resetTransferLinkInFlightForTest } =
    await import('../../src/import/transferContactLink');
  _resetTransferLinkInFlightForTest();
  const acct = await Account.create({ householdId, name: 'Chequing', accountType: 'checking', currency: 'CAD' });
  const caelan = await Contact.create({ householdId, name: 'Caelan', aliases: 'iten-mcgrath' });
  const t1 = await Transaction.create({
    householdId, accountId: acct.id, date: '2019-07-22', amount: '-200.0000', currency: 'CAD',
    txnType: 'transfer', merchantRaw: 'ONLINE TRANSFER SENT - 5552 CAELAN ANTHONY ITEN-MCGRATH', merchantClean: 'Online transfer sent',
    importBatch: 'transfer-link-test',
    sourceRowFingerprint: 'tfr-link-fp-1',
    sourceIdentityFingerprint: 'tfr-link-fp-1',
  } as never);

  const dry = await runTransferContactLink({ householdId, dryRun: true });
  assert.equal(dry.linked, 1);
  assert.equal((await Transaction.findByPk(t1.id))?.counterpartyContactId, null, 'dry run writes nothing');

  const wet = await runTransferContactLink({ householdId });
  assert.equal(wet.linked, 1);
  assert.equal((await Transaction.findByPk(t1.id))?.counterpartyContactId, caelan.id);

  const again = await runTransferContactLink({ householdId });
  assert.equal(again.linked, 0, 'idempotent — already linked rows skipped');
});
