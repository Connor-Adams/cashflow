/**
 * DB-backed tests for the write paths Task 6 adds:
 *
 *   - PATCH /api/transactions/:id { counterpartyRole } — validated against
 *     the COUNTERPARTY_ROLES vocabulary (Task 2) and audit-logged so a retag
 *     is traceable. `transfer_purpose` vocabulary (owner_draw, etc.) must be
 *     rejected — it is a different column answering a different question
 *     (see backend/src/contacts/counterpartyRole.ts).
 *   - PATCH /api/contacts/:id { loanDefault } — coerced via the existing
 *     coerceBool helper, rejecting non-boolean input.
 *   - GET /api/contacts includes loanDefault in the list projection so the
 *     frontend can render the toggle without a second fetch.
 *
 * Mounts the transactions and contacts routers behind a stubbed req.auth
 * (matching the pattern in ./contactsLedger.test.ts, itself copied from
 * ./items.test.ts) on the per-process SQLite test DB.
 */
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';

process.env.DATABASE_PATH = ':memory:';

let models: typeof import('../models');
let app: express.Express;
let household: { id: number };
let contactId: number;
let txnId: number;
let userId: number;

before(async () => {
  models = await import('../models');
  await models.sequelize.sync({ force: true });
  household = await models.Household.create({ name: 'Role Patch Test HH' });
  const user = await models.User.create({
    email: 'role-patch-test@test.local',
    displayName: 'Role Patch Test User',
    passwordHash: 'x',
    passwordSalt: 'x',
    passwordParams: 'x',
  } as never);
  userId = user.id;
  const contact = await models.Contact.create({
    householdId: household.id,
    name: 'Evan Adcock',
  } as never);
  contactId = contact.id;
  const account = await models.Account.create({
    householdId: household.id,
    name: 'Role Patch Test Chequing',
  } as never);
  const txn = await models.Transaction.create({
    householdId: household.id,
    accountId: account.id,
    importBatch: 'role-patch-test',
    date: '2026-01-01',
    merchantRaw: 'Sent money to Evan Adcock',
    merchantClean: 'Sent money to',
    amount: '-100.0000',
    currency: 'CAD',
    sourceRowFingerprint: 'role-patch-test-row-1',
    sourceIdentityFingerprint: 'role-patch-test-id-1',
    counterpartyContactId: contactId,
    visibility: 'shared',
  } as never);
  txnId = txn.id;

  const transactionsRouter = (await import('./transactions')).default;
  const contactsRouter = (await import('./contacts')).default;
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.auth = {
      user: { id: userId, globalRole: 'member' },
      household,
      role: 'owner',
    } as unknown as NonNullable<typeof req.auth>;
    next();
  });
  app.use('/api/transactions', transactionsRouter);
  app.use('/api/contacts', contactsRouter);
});

after(async () => {
  await models.sequelize.close();
});

const patchTransaction = (id: number, body: Record<string, unknown>) =>
  request(app).patch(`/api/transactions/${id}`).send(body);

const patchContact = (id: number, body: Record<string, unknown>) =>
  request(app).patch(`/api/contacts/${id}`).send(body);

const getContacts = () => request(app).get('/api/contacts');

test('PATCH /api/transactions/:id accepts a ledger role and persists it', async () => {
  const res = await patchTransaction(txnId, { counterpartyRole: 'loan' });
  assert.equal(res.status, 200);
  const fresh = await models.Transaction.findByPk(txnId);
  assert.equal(fresh?.counterpartyRole, 'loan');
});

test('PATCH /api/transactions/:id clears the role on null', async () => {
  await patchTransaction(txnId, { counterpartyRole: 'loan' });
  const res = await patchTransaction(txnId, { counterpartyRole: null });
  assert.equal(res.status, 200);
  const fresh = await models.Transaction.findByPk(txnId);
  assert.equal(fresh?.counterpartyRole, null);
});

test('PATCH /api/transactions/:id rejects transfer_purpose vocabulary', async () => {
  // owner_draw belongs to transfer_purpose — a different column answering a
  // different question. Accepting it here would silently cross the two.
  const res = await patchTransaction(txnId, { counterpartyRole: 'owner_draw' });
  assert.equal(res.status, 400);
  const fresh = await models.Transaction.findByPk(txnId);
  assert.equal(fresh?.counterpartyRole, null, 'a rejected patch must not write');
});

test('a retag is recorded in the audit log', async () => {
  await patchTransaction(txnId, { counterpartyRole: 'repayment' });
  const entry = await models.AuditLog.findOne({
    where: { entityType: 'transaction', entityId: txnId },
    order: [['createdAt', 'DESC']],
  });
  assert.ok(entry, 'untraceable retags are what made this audit necessary');
  assert.match(JSON.stringify(entry?.after), /counterpartyRole/);
});

test('PATCH /api/contacts/:id sets loanDefault', async () => {
  const res = await patchContact(contactId, { loanDefault: true });
  assert.equal(res.status, 200);
  const fresh = await models.Contact.findByPk(contactId);
  assert.equal(fresh?.loanDefault, true);
});

test('PATCH /api/contacts/:id rejects a non-boolean loanDefault', async () => {
  const res = await patchContact(contactId, { loanDefault: 'maybe' });
  assert.equal(res.status, 400);
});

test('GET /api/contacts returns loanDefault so the list can render the toggle', async () => {
  await patchContact(contactId, { loanDefault: true });
  const res = await getContacts();
  const row = res.body.find((c: { id: number }) => c.id === contactId);
  assert.equal(row.loanDefault, true);
});
