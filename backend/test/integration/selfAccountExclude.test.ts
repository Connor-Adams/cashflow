// backend/test/integration/selfAccountExclude.test.ts
//
// Integration tests for self-account auto-suggest + link-pass exclusion.
//
// (a) GET /api/contacts/self-suggestions returns contacts whose name tokens
//     overlap the logged-in user's displayName tokens or account name tokens.
// (b) PATCH /api/contacts/:id { isSelf: true } confirms the contact.
// (c) runTransferContactLink excludes isSelf=true contacts from the link pass:
//     a transfer that matches both a normal contact and a self-flagged contact
//     is linked to the normal contact only (or stays unlinked if the self
//     contact was the only match).
//
// Uses the authed-agent pattern from contactLedger.test.ts for HTTP parts
// and direct model calls for runTransferContactLink.

import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let testDb: PgTestDb;
let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let householdId: number;

before(async () => {
  testDb = await setupPgTestDb('self-account-exclude');
  app = (await import('../../src/app.js')).default;
  authed = request.agent(app);

  // Register as "Connor Adams" — tokens ['connor', 'adams'] from displayName.
  const reg = await authed.post('/api/auth/register').send({
    email: 'connor-self@example.com',
    displayName: 'Connor Adams',
    password: 'password123',
  });
  assert.equal(reg.status, 201, `register failed: ${JSON.stringify(reg.body)}`);
  householdId = (reg.body.user.household?.id ?? reg.body.user.householdId) as number;
});

after(async () => { await teardownPgTestDb(testDb); });

test('(a) GET /api/contacts/self-suggestions returns contacts matching user name', async () => {
  const { Account, Contact } = await import('../../src/models');

  // Create an account whose name contributes tokens (rbc → matches nothing alone here).
  const acct = await Account.create({
    householdId,
    name: 'RBC Chequing',
    accountType: 'checking',
    currency: 'CAD',
    owner: 'Connor Adams',
  });

  // Self-ish contact: name overlaps user's displayName tokens ('connor', 'adams').
  const selfishContact = await Contact.create({
    householdId,
    name: 'Connor Adams RBC',
  });

  // Normal contact: name has no overlap with user tokens or account tokens.
  await Contact.create({
    householdId,
    name: 'Caelan',
  });

  const res = await authed.get('/api/contacts/self-suggestions');
  assert.equal(res.status, 200, `unexpected status: ${JSON.stringify(res.body)}`);
  assert.ok(Array.isArray(res.body.suggestions), 'expected suggestions array');

  const ids = (res.body.suggestions as Array<{ id: number }> ).map((s) => s.id);
  assert.ok(ids.includes(selfishContact.id), 'self-ish contact must be in suggestions');

  // "Caelan" must NOT appear — no token overlap.
  const caelanInSuggestions = (res.body.suggestions as Array<{ id: number; name: string }>)
    .some((s) => s.name === 'Caelan');
  assert.equal(caelanInSuggestions, false, 'Caelan must not be suggested');

  // Reason must mention the overlapping tokens.
  const selfEntry = (res.body.suggestions as Array<{ id: number; reason: string }>)
    .find((s) => s.id === selfishContact.id);
  assert.ok(selfEntry, 'self-ish contact must have an entry');
  assert.match(selfEntry.reason, /matches your name/);

  // Cleanup the account (avoids bleeding into later tests).
  await acct.destroy();
});

test('(b) PATCH /api/contacts/:id with isSelf:true confirms the contact', async () => {
  const { Contact } = await import('../../src/models');
  const contact = await Contact.create({ householdId, name: 'Connor Adams Savings' });

  const patch = await authed.patch(`/api/contacts/${contact.id}`).send({ isSelf: true });
  assert.equal(patch.status, 200, `patch failed: ${JSON.stringify(patch.body)}`);
  assert.equal(patch.body.isSelf, true, 'isSelf must be true in response');

  // Verify the DB was updated.
  const reloaded = await Contact.findByPk(contact.id);
  assert.equal(reloaded?.isSelf, true, 'isSelf must be persisted to DB');

  // Subsequent GET /self-suggestions must NOT surface this contact.
  const res = await authed.get('/api/contacts/self-suggestions');
  assert.equal(res.status, 200);
  const ids = (res.body.suggestions as Array<{ id: number }>).map((s) => s.id);
  assert.ok(!ids.includes(contact.id), 'already-confirmed self contact must not reappear in suggestions');
});

test('(c) runTransferContactLink excludes isSelf contacts from the link pass', async () => {
  const { Account, Contact, Transaction } = await import('../../src/models');
  const { runTransferContactLink, _resetTransferLinkInFlightForTest } =
    await import('../../src/import/transferContactLink');
  _resetTransferLinkInFlightForTest();

  const acct = await Account.create({
    householdId,
    name: 'Chequing Self Test',
    accountType: 'checking',
  });

  // Normal contact with a name unique enough to avoid ambiguity with all other
  // test contacts in this file. "Thornton" does not appear in any other contact.
  const normalContact = await Contact.create({ householdId, name: 'Marcus Thornton' });

  // Self contact: isSelf=true up-front (simulating a user who already confirmed).
  // "Zelda Xu" is completely unique; the link pass must never see this contact.
  const selfContact = await Contact.create({
    householdId,
    name: 'Zelda Xu Self',
    isSelf: true,
  });

  // Transfer whose merchant text unambiguously matches normalContact only.
  // "marcus thornton" is the full normalized name; it appears only in this text.
  const txn = await Transaction.create({
    householdId,
    accountId: acct.id,
    date: '2024-03-01',
    amount: '-150.0000',
    currency: 'CAD',
    txnType: 'transfer',
    merchantRaw: 'ONLINE TRANSFER SENT - MARCUS THORNTON',
    merchantClean: 'Online transfer sent',
    importBatch: 'self-exclude-test-c',
    sourceRowFingerprint: 'self-excl-c-fp-1',
    sourceIdentityFingerprint: 'self-excl-c-fp-1',
  } as never);

  // Transfer whose merchant text matches only the self-contact's name.
  // Since selfContact is isSelf=true it is excluded from the link pass; the txn
  // must stay unlinked (counterpartyContactId remains null).
  const selfTxn = await Transaction.create({
    householdId,
    accountId: acct.id,
    date: '2024-03-02',
    amount: '-200.0000',
    currency: 'CAD',
    txnType: 'transfer',
    merchantRaw: 'ONLINE TRANSFER SENT - ZELDA XU SELF',
    merchantClean: 'Online transfer sent',
    importBatch: 'self-exclude-test-c',
    sourceRowFingerprint: 'self-excl-c-fp-2',
    sourceIdentityFingerprint: 'self-excl-c-fp-2',
  } as never);

  const result = await runTransferContactLink({ householdId });

  // The normal transfer must be linked to normalContact.
  const linkedTxn = await Transaction.findByPk(txn.id);
  assert.equal(
    linkedTxn?.counterpartyContactId,
    normalContact.id,
    'transfer matching normalContact must be linked',
  );

  // The self-contact transfer must NOT be linked (selfContact excluded from link pass).
  const selfLinkedTxn = await Transaction.findByPk(selfTxn.id);
  assert.equal(
    selfLinkedTxn?.counterpartyContactId,
    null,
    'transfer matching isSelf contact must NOT be linked (self excluded from link pass)',
  );

  // selfContact id must not appear in ambiguous entries either.
  const selfInAmbiguous = result.ambiguous.some((a) =>
    a.contactIds.includes(selfContact.id),
  );
  assert.equal(selfInAmbiguous, false, 'self-contact must not appear in ambiguous results');
});
