// backend/test/integration/contactLedger.test.ts
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let testDb: PgTestDb;
let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let householdId: number;

before(async () => {
  testDb = await setupPgTestDb('contact-ledger');
  app = (await import('../../src/app.js')).default;
  authed = request.agent(app);
  const reg = await authed.post('/api/auth/register').send({
    email: 'ledger@example.com', displayName: 'Ledger User', password: 'password123',
  });
  assert.equal(reg.status, 201);
  householdId = (reg.body.user.household?.id ?? reg.body.user.householdId) as number;
});
after(async () => { await teardownPgTestDb(testDb); });

test('GET /api/contacts/:id/ledger returns net + tracked + flagged transfers', async () => {
  const { Account, Contact, Transaction, Reimbursement } = await import('../../src/models');
  const acct = await Account.create({ householdId, name: 'Chequing', accountType: 'checking', currency: 'CAD' });
  const caelan = await Contact.create({ householdId, name: 'Caelan' });
  const out = await Transaction.create({
    householdId, accountId: acct.id, date: '2020-01-01', amount: '-200.0000', currency: 'CAD',
    txnType: 'transfer', merchantRaw: 'TRANSFER CAELAN', merchantClean: 'Transfer', counterpartyContactId: caelan.id,
    importBatch: 'test-batch-1', sourceRowFingerprint: 'fp-out-1', sourceIdentityFingerprint: 'si-out-1',
  });
  await Transaction.create({
    householdId, accountId: acct.id, date: '2020-02-01', amount: '50.0000', currency: 'CAD',
    txnType: 'transfer', merchantRaw: 'TRANSFER CAELAN', merchantClean: 'Transfer', counterpartyContactId: caelan.id,
    importBatch: 'test-batch-1', sourceRowFingerprint: 'fp-in-1', sourceIdentityFingerprint: 'si-in-1',
  });
  await Reimbursement.create({ householdId, transactionId: out.id, contactId: caelan.id, amount: '200.0000', currency: 'CAD', status: 'expected' });

  const res = await authed.get(`/api/contacts/${caelan.id}/ledger`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.transferNet, [{ currency: 'CAD', sent: '200.0000', received: '50.0000', net: '150.0000' }]);
  assert.equal(res.body.trackedOutstandingByCurrency.CAD, '200.0000');
  const loanRow = res.body.transfers.find((t: { id: number }) => t.id === out.id);
  assert.equal(loanRow.isLoan, true);
  assert.equal(loanRow.direction, 'out');
});

test('GET /api/contacts/:id/ledger excludes Rent-categorized transfers from net + list', async () => {
  const { Account, Contact, Transaction } = await import('../../src/models');
  const acct = await Account.create({ householdId, name: 'Chequing2', accountType: 'checking', currency: 'CAD' });
  const stephen = await Contact.create({ householdId, name: 'Stephen' });
  // A real loan outflow (no category) + a Rent-tagged outflow to the same person.
  const loan = await Transaction.create({
    householdId, accountId: acct.id, date: '2021-01-01', amount: '-1000.0000', currency: 'CAD',
    txnType: 'transfer', merchantRaw: 'TRANSFER STEPHEN', merchantClean: 'Transfer', counterpartyContactId: stephen.id,
    importBatch: 'rent-batch', sourceRowFingerprint: 'fp-loan', sourceIdentityFingerprint: 'si-loan',
  });
  const rent = await Transaction.create({
    householdId, accountId: acct.id, date: '2021-02-01', amount: '-400.0000', currency: 'CAD',
    txnType: 'transfer', merchantRaw: 'TRANSFER STEPHEN', merchantClean: 'Transfer', counterpartyContactId: stephen.id,
    finalCategory: 'Rent',
    importBatch: 'rent-batch', sourceRowFingerprint: 'fp-rent', sourceIdentityFingerprint: 'si-rent',
  });

  const res = await authed.get(`/api/contacts/${stephen.id}/ledger`);
  assert.equal(res.status, 200);
  // Net reflects only the $1000 loan, not the $400 rent.
  assert.deepEqual(res.body.transferNet, [{ currency: 'CAD', sent: '1000.0000', received: '0.0000', net: '1000.0000' }]);
  // The rent row is absent from the transfer list; the loan row is present.
  assert.ok(res.body.transfers.find((t: { id: number }) => t.id === loan.id), 'loan transfer present');
  assert.equal(res.body.transfers.find((t: { id: number }) => t.id === rent.id), undefined, 'rent transfer excluded');
});
