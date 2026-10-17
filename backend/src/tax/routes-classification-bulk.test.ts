/**
 * Integration tests for POST /api/tax/classification-queue/bulk.
 *
 * Mirrors the auth-setup pattern from routes-classification-queue.test.ts:
 * - sequelize.sync({ force: true }) instead of running migrations.
 * - Models imported BEFORE sync so all model tables are registered/created.
 * - Direct User + Household + HouseholdMember + Session creation, then
 *   request.agent(app) with cookie injection.
 *
 * The atomicity tests are the point of the file: a half-applied batch leaves
 * the T1 and T2 sides of the same corp draws disagreeing, which is worse than
 * an untouched queue.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import crypto from 'crypto';

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let householdId: number;
let personalEntityId: number;
let corpEntityId: number;
let personalAccountId: number;
let corpAccountId: number;
let otherHouseholdId: number;
let otherAccountId: number;

before(async () => {
  process.env.NODE_ENV = 'test';

  const { sequelize } = await import('../db.js');
  const models = await import('../models/index.js');
  await sequelize.sync({ force: true });

  const mod = await import('../app.js');
  app = mod.default;

  const { hashPassword, hashToken } = await import('../auth/password.js');

  const password = await hashPassword('password123');
  const user = await models.User.create({
    email: `classification-bulk-${Date.now()}@example.com`,
    displayName: 'Classification Bulk Test',
    globalRole: 'user',
    passwordHash: password.hash,
    passwordSalt: password.salt,
    passwordParams: password.params,
  });

  const household = await models.Household.create({ name: 'Classification Bulk HH' });
  householdId = household.id;
  await models.HouseholdMember.create({
    householdId: household.id,
    userId: user.id,
    role: 'owner',
  });

  const personalEntity = await models.Entity.create({
    householdId: household.id,
    kind: 'personal',
    legalName: 'Bulk Person',
    jurisdiction: 'CA-ON',
    fiscalYearEnd: null,
  } as never);
  personalEntityId = personalEntity.id;

  const corpEntity = await models.Entity.create({
    householdId: household.id,
    kind: 'corp',
    legalName: 'Bulk Corp Inc',
    jurisdiction: 'CA-ON',
    fiscalYearEnd: '12-31',
  } as never);
  corpEntityId = corpEntity.id;

  const personalAccount = await models.Account.create({
    name: 'Personal Chk',
    householdId: household.id,
    accountType: 'checking',
    taxStatus: 'non_registered',
    defaultCurrency: 'CAD',
  } as never);
  personalAccountId = personalAccount.id;

  const corpAccount = await models.Account.create({
    name: 'Corp Chk',
    householdId: household.id,
    accountType: 'checking',
    taxStatus: 'non_registered',
    defaultCurrency: 'CAD',
  } as never);
  corpAccountId = corpAccount.id;

  const otherHousehold = await models.Household.create({ name: 'Bulk Other HH' });
  otherHouseholdId = otherHousehold.id;
  const otherAccount = await models.Account.create({
    name: 'Their Chk',
    householdId: otherHousehold.id,
    accountType: 'checking',
    taxStatus: 'non_registered',
    defaultCurrency: 'CAD',
  } as never);
  otherAccountId = otherAccount.id;

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24);
  await models.Session.create({
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt,
  });
  authed = request.agent(app);
  authed.jar.setCookie(`cashflow_session=${token}; Path=/`);
});

after(async () => {
  const { sequelize } = await import('../db.js');
  await sequelize.close();
});

let seq = 0;
function uniq(tag: string) {
  seq += 1;
  return `${tag}-${Date.now()}-${seq}`;
}

/** An unclassified payroll deposit on the household's personal account. */
async function payrollTxn(date = '2025-07-01', amount = '3000', hhId = householdId, acctId = personalAccountId) {
  const models = await import('../models/index.js');
  const fp = uniq('payroll');
  return models.Transaction.create({
    accountId: acctId,
    householdId: hhId,
    entityId: personalEntityId,
    date,
    amount,
    currency: 'CAD',
    txnType: 'income',
    visibility: 'shared',
    merchantRaw: 'PAYROLL DEPOSIT',
    merchantClean: 'PAYROLL DEPOSIT',
    importBatch: 'b',
    sourceRowFingerprint: `fp-${fp}`,
    sourceIdentityFingerprint: `sif-${fp}`,
  } as never);
}

/** A linked corp→personal draw pair; returns both legs. */
async function corpDrawPair(date = '2025-04-01', amount = '20000') {
  const models = await import('../models/index.js');
  const pfp = uniq('draw-p');
  const cfp = uniq('draw-c');
  const personal = await models.Transaction.create({
    accountId: personalAccountId,
    householdId,
    entityId: personalEntityId,
    date,
    amount,
    currency: 'CAD',
    txnType: 'transfer',
    visibility: 'shared',
    merchantRaw: 'OWNER DRAW IN',
    merchantClean: 'OWNER DRAW IN',
    importBatch: 'b',
    sourceRowFingerprint: `fp-${pfp}`,
    sourceIdentityFingerprint: `sif-${pfp}`,
  } as never);
  const corp = await models.Transaction.create({
    accountId: corpAccountId,
    householdId,
    entityId: corpEntityId,
    date,
    amount: `-${amount}`,
    currency: 'CAD',
    txnType: 'transfer',
    visibility: 'shared',
    merchantRaw: 'OWNER DRAW OUT',
    merchantClean: 'OWNER DRAW OUT',
    importBatch: 'b',
    sourceRowFingerprint: `fp-${cfp}`,
    sourceIdentityFingerprint: `sif-${cfp}`,
  } as never);
  await personal.update({ linkedTransactionId: corp.id });
  await corp.update({ linkedTransactionId: personal.id });
  return { personal, corp };
}

async function treatmentOf(id: number): Promise<string | null> {
  const models = await import('../models/index.js');
  const row = await models.Transaction.findByPk(id);
  return (row?.taxTreatmentOverride ?? null) as string | null;
}

test('POST /api/tax/classification-queue/bulk without auth returns 401', async () => {
  const p = await payrollTxn();
  const res = await request(app)
    .post('/api/tax/classification-queue/bulk')
    .send({ ids: [p.id], taxTreatmentOverride: 'employment_income' });
  assert.equal(res.status, 401, `expected 401, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(await treatmentOf(p.id), null, 'unauthenticated call must not write');
});

test('bulk applies one treatment to several rows in a single request', async () => {
  const a = await payrollTxn('2025-07-01');
  const b = await payrollTxn('2025-07-15');
  const c = await payrollTxn('2025-07-29');

  const res = await authed
    .post('/api/tax/classification-queue/bulk')
    .send({ ids: [a.id, b.id, c.id], taxTreatmentOverride: 'employment_income' });

  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  for (const row of [a, b, c]) {
    assert.equal(
      await treatmentOf(row.id),
      'employment_income',
      `txn ${row.id} should have been written`,
    );
  }
});

test('bulk response carries the updated rows so the caller need not refetch', async () => {
  const a = await payrollTxn('2025-06-01');
  const b = await payrollTxn('2025-06-15');

  const res = await authed
    .post('/api/tax/classification-queue/bulk')
    .send({ ids: [a.id, b.id], taxTreatmentOverride: 'not_income' });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(Array.isArray(res.body.updated), `expected updated array, got ${JSON.stringify(res.body)}`);
  const byId = new Map<number, Record<string, unknown>>(
    res.body.updated.map((r: { id: number }) => [r.id, r as Record<string, unknown>]),
  );
  for (const row of [a, b]) {
    const returned = byId.get(row.id);
    assert.ok(returned, `updated must include txn ${row.id}`);
    assert.equal(returned.taxTreatmentOverride, 'not_income');
    assert.equal(returned.accountName, 'Personal Chk', 'row must carry enough to render in place');
    // String(): DECIMAL round-trips as a JS number on SQLite and as a string on
    // Postgres — the queue endpoint has the same dual shape.
    assert.equal(String(returned.amount), String(row.amount));
  }
});

test('bulk mirrors the treatment onto the linked corp leg', async () => {
  const { personal, corp } = await corpDrawPair('2025-05-01', '14000');

  const res = await authed
    .post('/api/tax/classification-queue/bulk')
    .send({ ids: [personal.id], taxTreatmentOverride: 'non_eligible_dividend' });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(await treatmentOf(personal.id), 'non_eligible_dividend');
  assert.equal(
    await treatmentOf(corp.id),
    'non_eligible_dividend',
    'both legs must agree or T1 and T2 diverge',
  );
  const ids = res.body.updated.map((r: { id: number }) => r.id);
  assert.ok(ids.includes(corp.id), 'the mirrored leg must be reported back');
});

test('one unknown id rolls the whole batch back — the good rows are NOT written', async () => {
  const a = await payrollTxn('2025-08-01');
  const b = await payrollTxn('2025-08-15');

  const res = await authed
    .post('/api/tax/classification-queue/bulk')
    .send({ ids: [a.id, 9999999, b.id], taxTreatmentOverride: 'employment_income' });

  assert.equal(res.status, 404, `expected 404, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(await treatmentOf(a.id), null, 'row before the bad id must be rolled back');
  assert.equal(await treatmentOf(b.id), null, 'row after the bad id must be untouched');
});

test('an id from another household is refused and nothing in the batch is written', async () => {
  const models = await import('../models/index.js');
  const mine = await payrollTxn('2025-09-01');
  const fp = uniq('theirs');
  const theirs = await models.Transaction.create({
    accountId: otherAccountId,
    householdId: otherHouseholdId,
    date: '2025-09-01',
    amount: '9000',
    currency: 'CAD',
    txnType: 'income',
    visibility: 'shared',
    merchantRaw: 'THEIR PAY',
    merchantClean: 'THEIR PAY',
    importBatch: 'b',
    sourceRowFingerprint: `fp-${fp}`,
    sourceIdentityFingerprint: `sif-${fp}`,
  } as never);

  const res = await authed
    .post('/api/tax/classification-queue/bulk')
    .send({ ids: [mine.id, theirs.id], taxTreatmentOverride: 'employment_income' });

  assert.equal(res.status, 404, `expected 404, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(await treatmentOf(theirs.id), null, 'another household row must never be written');
  assert.equal(await treatmentOf(mine.id), null, 'the scoping violation must roll back my rows too');
});

test('bulk rejects an invalid treatment without writing', async () => {
  const a = await payrollTxn('2025-10-01');
  const res = await authed
    .post('/api/tax/classification-queue/bulk')
    .send({ ids: [a.id], taxTreatmentOverride: 'definitely_not_a_treatment' });
  assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(await treatmentOf(a.id), null);
});

test('bulk rejects an empty id list', async () => {
  const res = await authed
    .post('/api/tax/classification-queue/bulk')
    .send({ ids: [], taxTreatmentOverride: 'employment_income' });
  assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
});

test('bulk rejects a non-integer id', async () => {
  const res = await authed
    .post('/api/tax/classification-queue/bulk')
    .send({ ids: ['abc'], taxTreatmentOverride: 'employment_income' });
  assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
});

test('bulk with a null treatment clears the rows (undo for a whole batch)', async () => {
  const a = await payrollTxn('2025-11-01');
  await authed
    .post('/api/tax/classification-queue/bulk')
    .send({ ids: [a.id], taxTreatmentOverride: 'employment_income' });
  assert.equal(await treatmentOf(a.id), 'employment_income');

  const res = await authed
    .post('/api/tax/classification-queue/bulk')
    .send({ ids: [a.id], taxTreatmentOverride: null });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(await treatmentOf(a.id), null);
});

/** A linked personal→corp injection pair (money INTO the corp). */
async function injectionPair(date = '2025-03-01', amount = '10000') {
  const { personal, corp } = await corpDrawPair(date, amount);
  await personal.update({ amount: `-${amount}` });
  await corp.update({ amount });
  return { personal, corp };
}

test('bulk refuses to classify an injection into the corp as a dividend', async () => {
  const { personal, corp } = await injectionPair('2025-03-03', '10000');

  const res = await authed
    .post('/api/tax/classification-queue/bulk')
    .send({ ids: [personal.id], taxTreatmentOverride: 'non_eligible_dividend' });

  assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(await treatmentOf(personal.id), null);
  assert.equal(await treatmentOf(corp.id), null);
});

test('bulk refuses salary on the corp leg of an injection too', async () => {
  const { corp } = await injectionPair('2025-03-04', '5000');
  const res = await authed
    .post('/api/tax/classification-queue/bulk')
    .send({ ids: [corp.id], taxTreatmentOverride: 'salary' });
  assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
});

test('an injection can still be classified as a loan', async () => {
  const { personal } = await injectionPair('2025-03-05', '7000');
  const res = await authed
    .post('/api/tax/classification-queue/bulk')
    .send({ ids: [personal.id], taxTreatmentOverride: 'loan_advance' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(await treatmentOf(personal.id), 'loan_advance');
});

test('bulk does not mirror onto a sibling that is linked to a different row', async () => {
  // Prod had two rows (5456, 2895) both pointing at 992. Classifying one must
  // not overwrite the treatment of the other pair's leg.
  const { personal, corp } = await corpDrawPair('2025-03-06', '3000');
  const { personal: stray } = await corpDrawPair('2025-03-06', '3000');
  await stray.update({ linkedTransactionId: corp.id }); // one-way: corp still points at `personal`

  const res = await authed
    .post('/api/tax/classification-queue/bulk')
    .send({ ids: [stray.id], taxTreatmentOverride: 'non_eligible_dividend' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(await treatmentOf(stray.id), 'non_eligible_dividend');
  assert.equal(await treatmentOf(corp.id), null, 'a non-reciprocal sibling is not ours to write');
  assert.equal(await treatmentOf(personal.id), null);
});
