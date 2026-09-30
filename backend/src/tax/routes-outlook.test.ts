/**
 * GET /api/tax/personal/:year/outlook over the wire.
 *
 * The endpoint that answers the question Connor actually asked. Two facts it must
 * carry: he is not late for 2026, and 2027-03-15 is coming.
 */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import crypto from 'crypto';

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;

before(async () => {
  process.env.NODE_ENV = 'test';
  const { sequelize } = await import('../db.js');
  const models = await import('../models/index.js');
  await sequelize.sync({ force: true });
  app = (await import('../app.js')).default;

  const { hashPassword, hashToken } = await import('../auth/password.js');
  const password = await hashPassword('password123');
  const user = await models.User.create({
    email: `outlook-${Date.now()}@example.com`,
    displayName: 'Outlook Test', globalRole: 'user',
    passwordHash: password.hash, passwordSalt: password.salt, passwordParams: password.params,
  });
  const household = await models.Household.create({ name: 'Outlook HH' });
  await models.HouseholdMember.create({ householdId: household.id, userId: user.id, role: 'owner' });
  const personal = await models.Entity.create({
    householdId: household.id, kind: 'personal', legalName: 'Connor',
    jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  const corp = await models.Entity.create({
    householdId: household.id, kind: 'corp', legalName: 'CDG Inc.',
    jurisdiction: 'CA-ON', fiscalYearEnd: '12-31',
  });
  const account = await models.Account.create({
    name: 'WS Chequing', householdId: household.id, accountType: 'checking',
    entityId: personal.id, taxStatus: 'non_registered', defaultCurrency: 'CAD',
  } as never);

  // Six months of $14,000 draws in 2026, nothing in 2024 or 2025 — Connor's shape.
  let fp = 0;
  for (const m of ['01', '02', '03', '04', '05', '06']) {
    fp += 2;
    const corpLeg = await models.Transaction.create({
      accountId: account.id, householdId: household.id, entityId: corp.id,
      date: `2026-${m}-15`, amount: '-14000', currency: 'CAD',
      merchantRaw: 'X', merchantClean: 'X', txnType: 'transfer',
      importBatch: 'b', sourceRowFingerprint: `c${fp}`, sourceIdentityFingerprint: `sc${fp}`,
    } as never);
    await models.Transaction.create({
      accountId: account.id, householdId: household.id, entityId: personal.id,
      date: `2026-${m}-15`, amount: '14000', currency: 'CAD',
      merchantRaw: 'X', merchantClean: 'X', txnType: 'transfer',
      linkedTransactionId: corpLeg.id, taxTreatmentOverride: 'non_eligible_dividend',
      importBatch: 'b', sourceRowFingerprint: `p${fp}`, sourceIdentityFingerprint: `sp${fp}`,
    } as never);
  }

  const token = crypto.randomBytes(32).toString('hex');
  await models.Session.create({
    userId: user.id, tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
  });
  authed = request.agent(app);
  authed.jar.setCookie(`cashflow_session=${token}; Path=/`);
});

test('without auth it is 401', async () => {
  const res = await request(app).get('/api/tax/personal/2026/outlook');
  assert.equal(res.status, 401);
});

test('it reports no 2026 instalments, with the reason and the balance-due date', async () => {
  const res = await authed.get('/api/tax/personal/2026/outlook');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.obligation.required, false);
  assert.match(res.body.obligation.reason, /2025|2024/);
  assert.equal(res.body.obligation.balanceDueOn, '2027-04-30');
});

test('all three calculation options are offered, with the risky one flagged', async () => {
  const res = await authed.get('/api/tax/personal/2026/outlook');
  const bases = res.body.obligation.options.map((o: { basis: string }) => o.basis);
  assert.deepEqual(bases.sort(), ['current_year', 'no_calculation', 'prior_year']);
  const current = res.body.obligation.options.find((o: { basis: string }) => o.basis === 'current_year');
  assert.equal(current.carriesInterestRisk, true);
  assert.equal(res.body.obligation.recommended, 'prior_year');
});

test('the forward view carries its figures as strings and states its basis', async () => {
  const res = await authed.get('/api/tax/personal/2026/outlook');
  assert.equal(res.body.forward.isProjection, true);
  assert.equal(res.body.forward.draws.actualToDate, '84000.00');
  assert.equal(res.body.forward.draws.projectedTotal, '168000.00');
  assert.match(res.body.forward.draws.basis, /Projected from 6 months/);
  assert.equal(typeof res.body.forward.projectedAdditionalTax, 'string');
});

test('the three-year window is reported so the verdict is checkable', async () => {
  const res = await authed.get('/api/tax/personal/2026/outlook');
  assert.equal(res.body.netOwingByYear['2025'], '0.00');
  assert.equal(res.body.netOwingByYear['2024'], '0.00');
  assert.ok(Number(res.body.projectedCurrentYearNetOwing) > 3000);
});

test('an unverified rate table in the window is named on the response', async () => {
  const res = await authed.get('/api/tax/personal/2026/outlook');
  assert.ok(
    res.body.provenanceWarnings.some((w: string) => /2024/.test(w)),
    JSON.stringify(res.body.provenanceWarnings),
  );
});

test('an invalid year is refused', async () => {
  const res = await authed.get('/api/tax/personal/1999/outlook');
  assert.equal(res.status, 400);
});

test('a year with no rate table is 409, not 500', async () => {
  const res = await authed.get('/api/tax/personal/2099/outlook');
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.error, 'rate_table_missing');
});
