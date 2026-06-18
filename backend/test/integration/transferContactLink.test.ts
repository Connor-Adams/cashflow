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

test('ambiguous match — two contacts match same merchant text; row is never auto-linked', async () => {
  const { Account, Contact, Transaction } = await import('../../src/models');
  const { runTransferContactLink, _resetTransferLinkInFlightForTest } =
    await import('../../src/import/transferContactLink');
  _resetTransferLinkInFlightForTest();

  // contactP matches on alias "jones"; contactQ matches on alias "smith-jones"
  // — both appear in the same merchant text, creating an ambiguous match.
  const acct2 = await Account.create({ householdId, name: 'Savings', accountType: 'savings', currency: 'CAD' });
  const contactP = await Contact.create({ householdId, name: 'Patricia Jones', aliases: 'jones' });
  const contactQ = await Contact.create({ householdId, name: 'Quinn Smith-Jones', aliases: 'smith-jones' });
  const ambigTxn = await Transaction.create({
    householdId, accountId: acct2.id, date: '2024-01-15', amount: '-300.0000', currency: 'CAD',
    txnType: 'transfer',
    merchantRaw: 'ONLINE TRANSFER SENT - QUINN SMITH-JONES',
    merchantClean: 'Online transfer sent',
    importBatch: 'ambiguous-test',
    sourceRowFingerprint: 'tfr-ambig-fp-1',
    sourceIdentityFingerprint: 'tfr-ambig-fp-1',
  } as never);

  _resetTransferLinkInFlightForTest();
  const result = await runTransferContactLink({ householdId });

  // (a) the colliding row appears in result.ambiguous with both contact ids
  const ambigEntry = result.ambiguous.find((a) => a.txnId === ambigTxn.id);
  assert.ok(ambigEntry, 'ambiguous entry present for the colliding transaction');
  assert.ok(
    ambigEntry.contactIds.includes(contactP.id) && ambigEntry.contactIds.includes(contactQ.id),
    'ambiguous entry references both matching contacts',
  );

  // (b) the transaction is NOT auto-linked; counterpartyContactId stays null
  const reloaded = await Transaction.findByPk(ambigTxn.id);
  assert.equal(reloaded?.counterpartyContactId, null, 'ambiguous row is never auto-linked');
});
