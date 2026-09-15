/**
 * The reimbursements collection is `kind='principal'` only.
 *
 * The line-of-credit interest allocator writes its allocations into the same
 * `reimbursements` table with `kind='interest'`, `status='expected'` and the
 * rate window's last day as the due date. Before this filter every one of those
 * generated rows listed, aggregated and aged exactly like a claim a human had
 * logged by hand — a false provenance of precisely the kind the interest
 * feature exists to remove, and every one of them would have shown as overdue.
 *
 * Mounts the reimbursements router behind a stubbed req.auth on the per-process
 * SQLite test DB, matching ./contactsLedger.test.ts.
 */
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';

process.env.DATABASE_PATH = ':memory:';

let models: typeof import('../models');
let app: express.Express;
let household: { id: number };
let principalId: number;
let interestId: number;

before(async () => {
  models = await import('../models');
  await models.sequelize.sync({ force: true });
  household = await models.Household.create({ name: 'Kind Filter HH' });
  const contact = await models.Contact.create({
    householdId: household.id,
    name: 'Stephen Masseur',
  } as never);
  const account = await models.Account.create({
    householdId: household.id,
    name: 'Royal Credit Line',
  } as never);
  const txn = await models.Transaction.create({
    householdId: household.id,
    accountId: account.id,
    importBatch: 'kind-filter-test',
    date: '2026-01-15',
    merchantRaw: 'E-TRANSFER SENT STEPHEN',
    merchantClean: 'E-TRANSFER SENT',
    amount: '-6700.0000',
    currency: 'CAD',
    sourceRowFingerprint: 'kind-filter-row-1',
    sourceIdentityFingerprint: 'kind-filter-id-1',
    counterpartyContactId: contact.id,
    counterpartyRole: 'loan',
  } as never);

  // A hand-logged claim: what this collection is for.
  const principal = await models.Reimbursement.create({
    householdId: household.id,
    transactionId: txn.id,
    contactId: contact.id,
    amount: '6700.0000',
    currency: 'CAD',
    // Past due, so it reaches the overdue queue too.
    dueDate: '2026-02-15',
    status: 'expected',
    kind: 'principal',
  } as never);
  principalId = principal.id;

  // A generated allocation: shaped exactly as runInterestAllocation writes it.
  const interest = await models.Reimbursement.create({
    householdId: household.id,
    transactionId: null,
    contactId: contact.id,
    amount: '174.8000',
    currency: 'CAD',
    dueDate: '2026-09-03',
    status: 'expected',
    kind: 'interest',
    sourceTransactionId: null,
  } as never);
  interestId = interest.id;

  const reimbursementsRouter = (await import('./reimbursements')).default;
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.auth = {
      user: { id: 1, globalRole: 'member' },
      household,
      role: 'owner',
    } as unknown as NonNullable<typeof req.auth>;
    next();
  });
  app.use('/api', reimbursementsRouter);
});

after(async () => {
  await models.sequelize.close();
});

test('GET /api/reimbursements omits generated interest rows', async () => {
  const res = await request(app).get('/api/reimbursements?today=2026-09-15');
  assert.equal(res.status, 200);
  const ids: number[] = res.body.data.map((d: { id: number }) => d.id);
  assert.ok(ids.includes(principalId), 'the hand-logged claim must still list');
  assert.ok(
    !ids.includes(interestId),
    'an allocated interest row is not a hand-logged claim and must not list here',
  );
  assert.equal(res.body.count, 1);
});

test('GET /api/reimbursements/overdue omits generated interest rows', async () => {
  const res = await request(app).get('/api/reimbursements/overdue?today=2026-09-15');
  assert.equal(res.status, 200);
  const ids: number[] = res.body.data.map((d: { id: number }) => d.id);
  assert.deepEqual(ids, [principalId], 'every interest row is past due by construction');
});

test('GET /api/reimbursements/summary excludes allocated interest from the total', async () => {
  const res = await request(app).get('/api/reimbursements/summary?today=2026-09-15');
  assert.equal(res.status, 200);
  // 6700 principal, not 6874.80: interest is reported by the People page's own
  // tiles and must never be folded into the outstanding claim aggregate.
  assert.equal(res.body.outstandingByCurrency.CAD, '6700.0000');
});
