// backend/test/integration/contactLedger.test.ts
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { testAgent } from './_setup/testServer.js';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let testDb: PgTestDb;
let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let householdId: number;

before(async () => {
  testDb = await setupPgTestDb('contact-ledger');
  app = (await import('../../src/app.js')).default;
  authed = testAgent(app);
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

test('GET /api/contacts/:id/ledger keeps rent-tagged transfers out of the loan balance', async () => {
  const { Account, Contact, Transaction } = await import('../../src/models');
  const acct = await Account.create({ householdId, name: 'Chequing2', accountType: 'checking', currency: 'CAD' });
  const stephen = await Contact.create({ householdId, name: 'Stephen' });
  // A real loan outflow + a rent outflow to the same person. `final_category`
  // is deliberately still 'Rent' on the second row: the category no longer
  // decides anything — `counterparty_role` does — and this proves the old
  // category-based exclusion is gone rather than silently still running.
  const loan = await Transaction.create({
    householdId, accountId: acct.id, date: '2021-01-01', amount: '-1000.0000', currency: 'CAD',
    txnType: 'transfer', merchantRaw: 'TRANSFER STEPHEN', merchantClean: 'Transfer', counterpartyContactId: stephen.id,
    counterpartyRole: 'loan',
    importBatch: 'rent-batch', sourceRowFingerprint: 'fp-loan', sourceIdentityFingerprint: 'si-loan',
  });
  const rent = await Transaction.create({
    householdId, accountId: acct.id, date: '2021-02-01', amount: '-400.0000', currency: 'CAD',
    txnType: 'transfer', merchantRaw: 'TRANSFER STEPHEN', merchantClean: 'Transfer', counterpartyContactId: stephen.id,
    finalCategory: 'Rent', counterpartyRole: 'rent',
    importBatch: 'rent-batch', sourceRowFingerprint: 'fp-rent', sourceIdentityFingerprint: 'si-rent',
  });

  const res = await authed.get(`/api/contacts/${stephen.id}/ledger`);
  assert.equal(res.status, 200);

  // The debt number counts the $1000 loan and nothing else — rent is not a debt.
  assert.deepEqual(
    res.body.loanBalance,
    [{ currency: 'CAD', lent: '1000.0000', repaid: '0.0000', balance: '1000.0000' }],
    'rent contributes nothing to the loan balance',
  );
  // transferNet is now descriptive raw flow, so it DOES include the rent money.
  // That split is the point: raw flow ≠ owed.
  assert.deepEqual(res.body.transferNet, [{ currency: 'CAD', sent: '1400.0000', received: '0.0000', net: '1400.0000' }]);

  // Both rows are listed; the rent row shows *why* it counted for nothing.
  const loanRow = res.body.transfers.find((t: { id: number }) => t.id === loan.id);
  assert.ok(loanRow, 'loan transfer present');
  assert.equal(loanRow.ledgerEffect, 'loan');
  const rentRow = res.body.transfers.find((t: { id: number }) => t.id === rent.id);
  assert.ok(rentRow, 'rent transfer is listed, not hidden');
  assert.equal(rentRow.counterpartyRole, 'rent');
  assert.equal(rentRow.ledgerEffect, 'none', 'rent is inert in the balance');
  assert.equal(rentRow.amount, '-400.0000', 'amounts are fixed to 4 decimals on both dialects');
});
