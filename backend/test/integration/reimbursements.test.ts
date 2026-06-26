/**
 * Integration tests for the reimbursement tracker route surface (issue #216),
 * exercised end-to-end against a real Postgres database:
 *   POST   /api/transactions/:id/reimbursable
 *   GET    /api/reimbursements (+ filters)
 *   GET    /api/reimbursements/summary
 *   GET    /api/reimbursements/overdue
 *   GET/PUT/DELETE /api/reimbursements/:id
 *   GET    /api/reimbursements/:id/match-candidates
 *   POST   /api/reimbursements/:id/link-repayment | unlink-repayment
 *   GET    /api/transactions?reimbursable=true|false
 * Seeding shape mirrors returnWarranty.test.ts (accounts use the seeded
 * user's id — never a literal id — to satisfy the owner_user_id FK).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
import { testAgent } from './_setup/testServer.js';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let primaryAgent: ReturnType<typeof request.agent>;
let primaryHouseholdId: number;
let primaryAccountId: number;
let primaryUserId: number;
let primaryContactId: number;
let otherAgent: ReturnType<typeof request.agent>;
let otherHouseholdId: number;
let otherAccountId: number;
let otherContactId: number;
let testDb: PgTestDb;

type Seeded = {
  token: string;
  householdId: number;
  userId: number;
  accountId: number;
  contactId: number;
};

async function seed(emailPrefix: string): Promise<Seeded> {
  const models = await import('../../src/models');
  const { hashPassword, hashToken } = await import('../../src/auth/password.js');
  const password = await hashPassword('password123');
  const user = await models.User.create({
    email: `${emailPrefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
    displayName: emailPrefix,
    globalRole: 'user',
    passwordHash: password.hash,
    passwordSalt: password.salt,
    passwordParams: password.params,
  });
  const household = await models.Household.create({ name: `${emailPrefix} household` });
  await models.HouseholdMember.create({
    householdId: household.id,
    userId: user.id,
    role: 'owner',
  });
  const account = await models.Account.create({
    householdId: household.id,
    ownerUserId: user.id,
    owner: 'me',
    visibility: 'shared',
    name: `${emailPrefix} card`,
    accountType: 'credit',
    defaultCurrency: 'CAD',
    shortCode: emailPrefix.slice(0, 3).toUpperCase(),
  });
  const contact = await models.Contact.create({
    householdId: household.id,
    name: `${emailPrefix} Contact`,
    notes: null,
  });
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24);
  await models.Session.create({
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt,
  });
  return {
    token,
    householdId: household.id,
    userId: user.id,
    accountId: account.id,
    contactId: contact.id,
  };
}

async function createTransaction(
  householdId: number,
  accountId: number,
  date: string,
  amount: number,
  options: { createdByUserId?: number | null; currency?: string } = {},
): Promise<number> {
  const models = await import('../../src/models');
  const created = await models.Transaction.create({
    accountId,
    householdId,
    visibility: 'shared',
    ownershipType: 'me',
    ownershipContactId: null,
    importBatch: 'reimb-test',
    date,
    merchantRaw: 'Test Merchant',
    merchantClean: 'Test Merchant',
    amount: amount.toFixed(4),
    currency: options.currency ?? 'CAD',
    notes: null,
    sourceReference: null,
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
    appliedRuleId: null,
    autoCategory: null,
    categoryOverride: null,
    finalCategory: null,
    autoBusiness: null,
    businessOverride: null,
    finalBusiness: false,
    autoSplitType: null,
    splitOverride: null,
    finalSplitType: 'me',
    autoPctMe: null,
    pctMeOverride: null,
    finalPctMe: null,
    autoPctPartner: null,
    pctPartnerOverride: null,
    finalPctPartner: null,
    reviewFlag: false,
    reviewedAt: null,
    createdByUserId: options.createdByUserId ?? null,
  });
  return created.id;
}

function isoDaysFromNow(days: number): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + days);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

before(async () => {
  // CRITICAL: NODE_ENV='test' before the route module loads so the
  // aiSuggestLimiter skip() short-circuits. The reimbursements router mounts
  // the limiter (router.use(aiSuggestLimiter)) on ALL its routes; this test
  // file fires >20 sequential requests from the same client, which would
  // otherwise trip the 60s/20-request window and 429 every assertion past the
  // first handful (mirrors cfoBriefings/statements integration tests).
  process.env.NODE_ENV = 'test';

  testDb = await setupPgTestDb('reimbursements');
  const mod = await import('../../src/app.js');
  app = mod.default;

  const bootstrap = testAgent(app);
  const register = await bootstrap.post('/api/auth/register').send({
    email: 'superadmin@example.com',
    displayName: 'Super Admin',
    password: 'password123',
  });
  assert.equal(register.status, 201);

  const primary = await seed('Primary');
  primaryHouseholdId = primary.householdId;
  primaryAccountId = primary.accountId;
  primaryUserId = primary.userId;
  primaryContactId = primary.contactId;
  primaryAgent = testAgent(app);
  primaryAgent.jar.setCookie(`cashflow_session=${primary.token}; Path=/`);

  const other = await seed('Other');
  otherHouseholdId = other.householdId;
  otherAccountId = other.accountId;
  otherContactId = other.contactId;
  otherAgent = testAgent(app);
  otherAgent.jar.setCookie(`cashflow_session=${other.token}; Path=/`);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

// ---- mark reimbursable ----------------------------------------------------

test('POST /reimbursable creates a claim defaulting amount + currency', async () => {
  const txnId = await createTransaction(primaryHouseholdId, primaryAccountId, '2026-02-01', -120);
  const res = await primaryAgent
    .post(`/api/transactions/${txnId}/reimbursable`)
    .send({ partyName: 'Acme Corp', dueDate: isoDaysFromNow(14) });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.transactionId, txnId);
  assert.equal(res.body.data.amount, '120.0000');
  assert.equal(res.body.data.currency, 'CAD');
  assert.equal(res.body.data.partyName, 'Acme Corp');
  assert.equal(res.body.data.partyLabel, 'Acme Corp');
  assert.equal(res.body.data.status, 'expected');
});

test('POST /reimbursable accepts a structured Contact party', async () => {
  const txnId = await createTransaction(primaryHouseholdId, primaryAccountId, '2026-02-02', -75);
  const res = await primaryAgent
    .post(`/api/transactions/${txnId}/reimbursable`)
    .send({ contactId: primaryContactId, amount: 60 });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.contactId, primaryContactId);
  assert.equal(res.body.data.amount, '60.0000');
  assert.equal(res.body.data.partyLabel, 'Primary Contact');
});

test('POST /reimbursable requires a party', async () => {
  const txnId = await createTransaction(primaryHouseholdId, primaryAccountId, '2026-02-03', -50);
  const res = await primaryAgent.post(`/api/transactions/${txnId}/reimbursable`).send({});
  assert.equal(res.status, 400);
});

test('POST /reimbursable rejects a Contact from another household', async () => {
  const txnId = await createTransaction(primaryHouseholdId, primaryAccountId, '2026-02-04', -50);
  const res = await primaryAgent
    .post(`/api/transactions/${txnId}/reimbursable`)
    .send({ contactId: otherContactId });
  assert.equal(res.status, 400);
});

test('POST /reimbursable 404 for a transaction in another household', async () => {
  const otherTxn = await createTransaction(otherHouseholdId, otherAccountId, '2026-02-05', -50);
  const res = await primaryAgent
    .post(`/api/transactions/${otherTxn}/reimbursable`)
    .send({ partyName: 'X' });
  assert.equal(res.status, 404);
});

// ---- lifecycle: list, patch, link, unlink ---------------------------------

test('full lifecycle: expected -> received via link, then reopen via unlink', async () => {
  const outlay = await createTransaction(primaryHouseholdId, primaryAccountId, '2026-03-01', -200);
  const created = await primaryAgent
    .post(`/api/transactions/${outlay}/reimbursable`)
    .send({ partyName: 'Bob', dueDate: isoDaysFromNow(10) });
  const claimId = created.body.data.id as number;

  // A matching inflow repayment.
  const repayment = await createTransaction(primaryHouseholdId, primaryAccountId, '2026-03-05', 200);

  // Match candidates should surface the repayment.
  const cand = await primaryAgent.get(`/api/reimbursements/${claimId}/match-candidates`);
  assert.equal(cand.status, 200);
  const candIds = (cand.body.data as { transactionId: number }[]).map((c) => c.transactionId);
  assert.ok(candIds.includes(repayment), 'repayment should be a candidate');

  // Link it → status flips to received with a receivedAt.
  const linked = await primaryAgent
    .post(`/api/reimbursements/${claimId}/link-repayment`)
    .send({ transactionId: repayment });
  assert.equal(linked.status, 200);
  assert.equal(linked.body.data.status, 'received');
  assert.equal(linked.body.data.repaymentTransactionId, repayment);
  assert.ok(linked.body.data.receivedAt, 'receivedAt should be set');

  // Unlink → reopens to expected, clears receivedAt + repayment.
  const unlinked = await primaryAgent.post(`/api/reimbursements/${claimId}/unlink-repayment`).send({});
  assert.equal(unlinked.status, 200);
  assert.equal(unlinked.body.data.status, 'expected');
  assert.equal(unlinked.body.data.repaymentTransactionId, null);
  assert.equal(unlinked.body.data.receivedAt, null);
});

test('PUT updates status + party; clearing both party fields is rejected', async () => {
  const outlay = await createTransaction(primaryHouseholdId, primaryAccountId, '2026-03-10', -90);
  const created = await primaryAgent
    .post(`/api/transactions/${outlay}/reimbursable`)
    .send({ partyName: 'Carol' });
  const claimId = created.body.data.id as number;

  const waived = await primaryAgent
    .put(`/api/reimbursements/${claimId}`)
    .send({ status: 'waived', notes: 'forgiven' });
  assert.equal(waived.status, 200);
  assert.equal(waived.body.data.status, 'waived');
  assert.equal(waived.body.data.notes, 'forgiven');

  const bad = await primaryAgent
    .put(`/api/reimbursements/${claimId}`)
    .send({ contactId: null, partyName: null });
  assert.equal(bad.status, 400);
});

test('DELETE removes a claim', async () => {
  const outlay = await createTransaction(primaryHouseholdId, primaryAccountId, '2026-03-15', -30);
  const created = await primaryAgent
    .post(`/api/transactions/${outlay}/reimbursable`)
    .send({ partyName: 'Dave' });
  const claimId = created.body.data.id as number;
  const del = await primaryAgent.delete(`/api/reimbursements/${claimId}`);
  assert.equal(del.status, 204);
  const get = await primaryAgent.get(`/api/reimbursements/${claimId}`);
  assert.equal(get.status, 404);
});

// ---- list filters ---------------------------------------------------------

test('GET /reimbursements filters by status and contactId', async () => {
  const t1 = await createTransaction(primaryHouseholdId, primaryAccountId, '2026-04-01', -40);
  await primaryAgent
    .post(`/api/transactions/${t1}/reimbursable`)
    .send({ contactId: primaryContactId });

  const byContact = await primaryAgent.get(
    `/api/reimbursements?contactId=${primaryContactId}`,
  );
  assert.equal(byContact.status, 200);
  assert.ok(
    (byContact.body.data as { contactId: number | null }[]).every(
      (d) => d.contactId === primaryContactId,
    ),
    'all rows should match the contact filter',
  );

  const expected = await primaryAgent.get('/api/reimbursements?status=expected');
  assert.equal(expected.status, 200);
  assert.ok(
    (expected.body.data as { status: string }[]).every((d) => d.status === 'expected'),
  );
});

// ---- overdue queue + derived overdue --------------------------------------

test('GET /reimbursements/overdue surfaces past-due open claims', async () => {
  const outlay = await createTransaction(primaryHouseholdId, primaryAccountId, '2026-01-01', -55);
  const created = await primaryAgent
    .post(`/api/transactions/${outlay}/reimbursable`)
    .send({ partyName: 'Late Payer', dueDate: isoDaysFromNow(-5) });
  const claimId = created.body.data.id as number;

  const overdue = await primaryAgent.get('/api/reimbursements/overdue');
  assert.equal(overdue.status, 200);
  const ids = (overdue.body.data as { id: number; effectiveStatus: string }[]);
  const found = ids.find((d) => d.id === claimId);
  assert.ok(found, 'past-due claim should appear in overdue queue');
  assert.equal(found!.effectiveStatus, 'overdue');

  // overdueOnly filter on the main list should also include it.
  const filtered = await primaryAgent.get('/api/reimbursements?overdueOnly=true');
  assert.ok(
    (filtered.body.data as { id: number }[]).some((d) => d.id === claimId),
  );
});

// ---- dashboard summary ----------------------------------------------------

test('GET /reimbursements/summary groups outstanding by party + currency', async () => {
  const fresh = await seed('Summary');
  const agent = testAgent(app);
  agent.jar.setCookie(`cashflow_session=${fresh.token}; Path=/`);

  const t1 = await createTransaction(fresh.householdId, fresh.accountId, '2026-05-01', -100);
  const t2 = await createTransaction(fresh.householdId, fresh.accountId, '2026-05-02', -50, {
    currency: 'USD',
  });
  await agent.post(`/api/transactions/${t1}/reimbursable`).send({
    contactId: fresh.contactId,
    dueDate: isoDaysFromNow(30),
  });
  await agent.post(`/api/transactions/${t2}/reimbursable`).send({
    contactId: fresh.contactId,
    amount: 50,
    currency: 'USD',
    dueDate: isoDaysFromNow(30),
  });

  const res = await agent.get('/api/reimbursements/summary');
  assert.equal(res.status, 200);
  assert.equal(res.body.outstandingByCurrency.CAD, '100.0000');
  assert.equal(res.body.outstandingByCurrency.USD, '50.0000');
  // Two groups: same contact, two currencies.
  assert.equal(res.body.groups.length, 2);
  assert.equal(res.body.totalCount, 2);
});

// ---- transaction list filter ----------------------------------------------

test('GET /transactions?reimbursable filters by claim presence', async () => {
  const fresh = await seed('Filter');
  const agent = testAgent(app);
  agent.jar.setCookie(`cashflow_session=${fresh.token}; Path=/`);

  const withClaim = await createTransaction(fresh.householdId, fresh.accountId, '2026-06-01', -100);
  const withoutClaim = await createTransaction(fresh.householdId, fresh.accountId, '2026-06-02', -200);
  await agent.post(`/api/transactions/${withClaim}/reimbursable`).send({ partyName: 'Eve' });

  const onlyReimb = await agent.get('/api/transactions?reimbursable=true');
  assert.equal(onlyReimb.status, 200);
  const reimbIds = (onlyReimb.body.data as { id: number }[]).map((t) => t.id);
  assert.ok(reimbIds.includes(withClaim), 'claimed txn should appear');
  assert.ok(!reimbIds.includes(withoutClaim), 'unclaimed txn should not appear');

  const notReimb = await agent.get('/api/transactions?reimbursable=false');
  const notIds = (notReimb.body.data as { id: number }[]).map((t) => t.id);
  assert.ok(notIds.includes(withoutClaim), 'unclaimed txn should appear');
  assert.ok(!notIds.includes(withClaim), 'claimed txn should not appear');
});

// ---- client-supplied `today` (local-midnight overdue boundaries) -----------

test('GET endpoints accept ?today= to shift the overdue boundary', async () => {
  const fresh = await seed('Today');
  const agent = testAgent(app);
  agent.jar.setCookie(`cashflow_session=${fresh.token}; Path=/`);

  const outlay = await createTransaction(fresh.householdId, fresh.accountId, '2026-08-01', -80);
  const due = isoDaysFromNow(5);
  await agent
    .post(`/api/transactions/${outlay}/reimbursable`)
    .send({ contactId: fresh.contactId, dueDate: due });

  // With the server's default (UTC) today the claim is open, not overdue.
  const def = await agent.get('/api/reimbursements/overdue');
  assert.ok(
    !(def.body.data as { transactionId: number }[]).some((d) => d.transactionId === outlay),
    'future-due claim should not be overdue by default',
  );

  // A client-local `today` past the due date flips it overdue everywhere.
  const later = isoDaysFromNow(6);
  const list = await agent.get(`/api/reimbursements?today=${later}`);
  assert.equal(list.status, 200);
  assert.equal(list.body.today, later);
  const item = (list.body.data as { transactionId: number; effectiveStatus: string; isOverdue: boolean }[])
    .find((d) => d.transactionId === outlay);
  assert.ok(item, 'claim should be listed');
  assert.equal(item!.effectiveStatus, 'overdue');
  assert.equal(item!.isOverdue, true);

  const overdue = await agent.get(`/api/reimbursements/overdue?today=${later}`);
  assert.ok(
    (overdue.body.data as { transactionId: number }[]).some((d) => d.transactionId === outlay),
    'claim should reach the overdue queue with the shifted today',
  );

  const sum = await agent.get(`/api/reimbursements/summary?today=${later}`);
  assert.equal(sum.body.today, later);
  assert.equal(sum.body.overdueCount, 1);

  // Contact detail open-claims aggregate honors the same param.
  const contact = await agent.get(`/api/contacts/${fresh.contactId}?today=${later}`);
  assert.equal(contact.status, 200);
  assert.equal(contact.body.today, later);
  assert.equal(contact.body.openReimbursements.items[0]?.effectiveStatus, 'overdue');

  // Invalid values fall back to the server's UTC today, not a 500.
  const bad = await agent.get('/api/reimbursements?today=not-a-date');
  assert.equal(bad.status, 200);
  assert.match(bad.body.today as string, /^\d{4}-\d{2}-\d{2}$/);
});

// ---- link-repayment eligibility + partial netting ---------------------------

test('link-repayment rejects outflows and cross-currency transactions', async () => {
  const outlay = await createTransaction(primaryHouseholdId, primaryAccountId, '2026-09-01', -100);
  const created = await primaryAgent
    .post(`/api/transactions/${outlay}/reimbursable`)
    .send({ partyName: 'Guard' });
  const claimId = created.body.data.id as number;

  const outflow = await createTransaction(primaryHouseholdId, primaryAccountId, '2026-09-02', -100);
  const badSign = await primaryAgent
    .post(`/api/reimbursements/${claimId}/link-repayment`)
    .send({ transactionId: outflow });
  assert.equal(badSign.status, 400);
  assert.match(badSign.body.error as string, /inflow/);

  const usdInflow = await createTransaction(
    primaryHouseholdId, primaryAccountId, '2026-09-03', 100, { currency: 'USD' },
  );
  const badCurrency = await primaryAgent
    .post(`/api/reimbursements/${claimId}/link-repayment`)
    .send({ transactionId: usdInflow });
  assert.equal(badCurrency.status, 400);
  assert.match(badCurrency.body.error as string, /currency/);

  // The claim stays open after both rejections.
  const get = await primaryAgent.get(`/api/reimbursements/${claimId}`);
  assert.equal(get.body.data.status, 'expected');
  assert.equal(get.body.data.repaymentTransactionId, null);
});

test('summary nets a partial repayment instead of the claim face value', async () => {
  const fresh = await seed('Partial');
  const agent = testAgent(app);
  agent.jar.setCookie(`cashflow_session=${fresh.token}; Path=/`);

  const outlay = await createTransaction(fresh.householdId, fresh.accountId, '2026-10-01', -200);
  const created = await agent
    .post(`/api/transactions/${outlay}/reimbursable`)
    .send({ contactId: fresh.contactId });
  const claimId = created.body.data.id as number;

  // Link a 150 repayment against the 200 claim (the matcher tolerates a 25%
  // mismatch, so this is a normal flow).
  const repayment = await createTransaction(fresh.householdId, fresh.accountId, '2026-10-05', 150);
  const linked = await agent
    .post(`/api/reimbursements/${claimId}/link-repayment`)
    .send({ transactionId: repayment });
  assert.equal(linked.status, 200);
  assert.equal(linked.body.data.status, 'received');

  const sum = await agent.get('/api/reimbursements/summary');
  const group = (sum.body.groups as { contactId: number | null; received: string }[])
    .find((g) => g.contactId === fresh.contactId);
  assert.ok(group, 'summary group expected');
  assert.equal(group!.received, '150.0000');
});

// ---- concurrency safety (issue #846) --------------------------------------

test('a repayment cannot be linked to two claims (no double-credit)', async () => {
  const fresh = await seed('NoDouble');
  const agent = testAgent(app);
  agent.jar.setCookie(`cashflow_session=${fresh.token}; Path=/`);

  // One outlay → two open claims (1:N is intended: e.g. a split).
  const outlay = await createTransaction(fresh.householdId, fresh.accountId, '2026-11-01', -100);
  const a = await agent
    .post(`/api/transactions/${outlay}/reimbursable`)
    .send({ partyName: 'A', amount: 100 });
  const b = await agent
    .post(`/api/transactions/${outlay}/reimbursable`)
    .send({ partyName: 'B', amount: 100 });
  const claimA = a.body.data.id as number;
  const claimB = b.body.data.id as number;

  // A single $100 inflow.
  const repayment = await createTransaction(fresh.householdId, fresh.accountId, '2026-11-05', 100);

  // Fire both links concurrently against the SAME repayment txn.
  const [r1, r2] = await Promise.all([
    agent.post(`/api/reimbursements/${claimA}/link-repayment`).send({ transactionId: repayment }),
    agent.post(`/api/reimbursements/${claimB}/link-repayment`).send({ transactionId: repayment }),
  ]);
  const statuses = [r1.status, r2.status].sort();
  assert.deepEqual(statuses, [200, 409], 'exactly one link wins; the other is a 409 conflict');

  // The inflow is credited exactly once across the household summary.
  const sum = await agent.get('/api/reimbursements/summary');
  const received = (sum.body.groups as { received: string }[]).reduce(
    (acc, g) => acc + Number(g.received),
    0,
  );
  assert.equal(received, 100, 'the single inflow must be credited exactly once');

  // Exactly one of the two claims holds the repayment.
  const [getA, getB] = await Promise.all([
    agent.get(`/api/reimbursements/${claimA}`),
    agent.get(`/api/reimbursements/${claimB}`),
  ]);
  const linkedCount = [getA, getB].filter(
    (g) => g.body.data.repaymentTransactionId === repayment,
  ).length;
  assert.equal(linkedCount, 1, 'only one claim ends up linked');
});

test('re-linking the same repayment to the same claim is idempotent', async () => {
  const fresh = await seed('Idempotent');
  const agent = testAgent(app);
  agent.jar.setCookie(`cashflow_session=${fresh.token}; Path=/`);

  const outlay = await createTransaction(fresh.householdId, fresh.accountId, '2026-11-10', -50);
  const created = await agent
    .post(`/api/transactions/${outlay}/reimbursable`)
    .send({ partyName: 'Repeat' });
  const claimId = created.body.data.id as number;
  const repayment = await createTransaction(fresh.householdId, fresh.accountId, '2026-11-11', 50);

  const first = await agent
    .post(`/api/reimbursements/${claimId}/link-repayment`)
    .send({ transactionId: repayment });
  assert.equal(first.status, 200);
  const second = await agent
    .post(`/api/reimbursements/${claimId}/link-repayment`)
    .send({ transactionId: repayment });
  assert.equal(second.status, 200, 're-link of the same pair should not 409');
  assert.equal(second.body.data.repaymentTransactionId, repayment);
});

test('concurrent link + unlink leave the claim internally consistent', async () => {
  const fresh = await seed('Interleave');
  const agent = testAgent(app);
  agent.jar.setCookie(`cashflow_session=${fresh.token}; Path=/`);

  const outlay = await createTransaction(fresh.householdId, fresh.accountId, '2026-11-15', -80);
  const created = await agent
    .post(`/api/transactions/${outlay}/reimbursable`)
    .send({ partyName: 'Race' });
  const claimId = created.body.data.id as number;
  const repayment = await createTransaction(fresh.householdId, fresh.accountId, '2026-11-16', 80);

  // Seed it as linked, then race a link(same) against an unlink.
  await agent
    .post(`/api/reimbursements/${claimId}/link-repayment`)
    .send({ transactionId: repayment });
  await Promise.all([
    agent.post(`/api/reimbursements/${claimId}/link-repayment`).send({ transactionId: repayment }),
    agent.post(`/api/reimbursements/${claimId}/unlink-repayment`).send({}),
  ]);

  // Whatever the winner, status and link must agree: received <=> linked.
  const get = await agent.get(`/api/reimbursements/${claimId}`);
  const { status, repaymentTransactionId, receivedAt } = get.body.data;
  if (repaymentTransactionId == null) {
    assert.notEqual(status, 'received', 'unlinked claim must not be received');
    assert.equal(receivedAt, null, 'unlinked claim must clear receivedAt');
  } else {
    assert.equal(repaymentTransactionId, repayment);
    assert.equal(status, 'received', 'linked claim must be received');
    assert.ok(receivedAt, 'linked claim must stamp receivedAt');
  }
});

test('concurrent PUTs do not clobber each other\'s untouched fields', async () => {
  const fresh = await seed('NoClobber');
  const agent = testAgent(app);
  agent.jar.setCookie(`cashflow_session=${fresh.token}; Path=/`);

  const outlay = await createTransaction(fresh.householdId, fresh.accountId, '2026-11-20', -300);
  const created = await agent
    .post(`/api/transactions/${outlay}/reimbursable`)
    .send({ partyName: 'Clobber', amount: 300 });
  const claimId = created.body.data.id as number;

  // One PUT changes amount, another changes status — disjoint fields.
  const [pa, pb] = await Promise.all([
    agent.put(`/api/reimbursements/${claimId}`).send({ amount: 250 }),
    agent.put(`/api/reimbursements/${claimId}`).send({ status: 'received' }),
  ]);
  assert.equal(pa.status, 200);
  assert.equal(pb.status, 200);

  // Both edits must survive — neither blind full-instance save wiped the other.
  const get = await agent.get(`/api/reimbursements/${claimId}`);
  assert.equal(get.body.data.amount, '250.0000', 'amount edit survived');
  assert.equal(get.body.data.status, 'received', 'status edit survived');
});

// ---- cross-household scope -------------------------------------------------

test('reimbursement endpoints scope to the requesting household', async () => {
  const otherTxn = await createTransaction(otherHouseholdId, otherAccountId, '2026-07-01', -60);
  const created = await otherAgent
    .post(`/api/transactions/${otherTxn}/reimbursable`)
    .send({ partyName: 'OtherParty' });
  const otherClaimId = created.body.data.id as number;

  const get = await primaryAgent.get(`/api/reimbursements/${otherClaimId}`);
  assert.equal(get.status, 404, 'other household claim should not be readable');

  const del = await primaryAgent.delete(`/api/reimbursements/${otherClaimId}`);
  assert.equal(del.status, 404, 'other household claim should not be deletable');
});
