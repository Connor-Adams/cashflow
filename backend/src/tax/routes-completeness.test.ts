/**
 * The completeness report reaches the wire on the path the Personal T1 tab reads,
 * and survives a warm cache.
 *
 * Two failures this pins:
 *
 *   1. An earlier draft of the design attached the gate to `routes/tax.ts` alone,
 *      whose only consumer is the Overview tab. `PersonalT1Tab` renders
 *      `useScenarioDetail` → `/api/tax/scenarios/personal/:id`, so that would have
 *      shipped the gate onto Overview and left the T1 showing a bare total — the
 *      exact failure the gate exists to prevent.
 *   2. Both return paths build their response twice, returning early on a cache hit.
 *      A gate attached to the miss path only vanishes whenever the cache is warm,
 *      which is worse than no gate: it is present while you are exploring and gone
 *      once you settle.
 */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import crypto from 'crypto';

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let personalId: number;
let corpId: number;
let scenarioId: number;
let householdId: number;

before(async () => {
  process.env.NODE_ENV = 'test';
  const { sequelize } = await import('../db.js');
  const models = await import('../models/index.js');
  await sequelize.sync({ force: true });
  app = (await import('../app.js')).default;

  const { hashPassword, hashToken } = await import('../auth/password.js');
  const password = await hashPassword('password123');
  const user = await models.User.create({
    email: `completeness-${Date.now()}@example.com`,
    displayName: 'Completeness Test',
    globalRole: 'user',
    passwordHash: password.hash,
    passwordSalt: password.salt,
    passwordParams: password.params,
  });
  const household = await models.Household.create({ name: 'Completeness HH' });
  householdId = household.id;
  await models.HouseholdMember.create({ householdId, userId: user.id, role: 'owner' });

  const personal = await models.Entity.create({
    householdId, kind: 'personal', legalName: 'Connor',
    jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  personalId = personal.id;
  const corp = await models.Entity.create({
    householdId, kind: 'corp', legalName: 'CDG Inc.',
    jurisdiction: 'CA-ON', fiscalYearEnd: '12-31',
  });
  corpId = corp.id;

  const corpAccount = await models.Account.create({
    name: 'Corp Chequing', householdId, accountType: 'checking',
    entityId: corpId, taxStatus: 'n_a', defaultCurrency: 'CAD',
  } as never);
  // An outbound corp transfer with nothing recording where it went — a blocker.
  await models.Transaction.create({
    accountId: corpAccount.id, householdId, entityId: corpId,
    date: '2026-05-01', amount: '-9000', currency: 'CAD',
    merchantRaw: 'TRANSFER', merchantClean: 'TRANSFER',
    importBatch: 'b', sourceRowFingerprint: 'cx1', sourceIdentityFingerprint: 'scx1',
    txnType: 'transfer',
  } as never);

  const scenario = await models.Scenario.create({
    entityId: personalId, year: 2026, kind: 'baseline', name: 'Baseline 2026',
    parentId: null, overrides: {}, assumptions: {},
  } as never);
  scenarioId = scenario.id;

  const token = crypto.randomBytes(32).toString('hex');
  await models.Session.create({
    userId: user.id, tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
  });
  authed = request.agent(app);
  authed.jar.setCookie(`cashflow_session=${token}; Path=/`);
});

test('the scenario detail path carries the completeness report', async () => {
  const res = await authed.get(`/api/tax/scenarios/personal/${scenarioId}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const c = res.body.computed?.completeness;
  assert.ok(c, `no completeness on the response: ${JSON.stringify(res.body.computed)}`);
  assert.equal(c.status, 'blocked');
  assert.ok(
    c.blockers.some((b: { kind: string }) => b.kind === 'unimported_outbound_corp_transfer'),
    JSON.stringify(c.blockers),
  );
});

test('it is still there on a cache hit', async () => {
  // The first request populated `scenario_returns`; this one is served from it.
  const res = await authed.get(`/api/tax/scenarios/personal/${scenarioId}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.computed.cached, true, 'expected a cache hit on the second call');
  assert.ok(res.body.computed.completeness, 'the gate must not vanish when the cache is warm');
  assert.equal(res.body.computed.completeness.status, 'blocked');
});

test('the resolved facts are not leaked to the client', async () => {
  // `facts` exists on the server-side result so the gate and the total share a basis.
  // It is an engine input full of Decimals, not part of the API contract.
  const res = await authed.get(`/api/tax/scenarios/personal/${scenarioId}`);
  assert.equal(res.body.computed.facts, undefined);
});

test('the plain return route carries it on both paths', async () => {
  const first = await authed.get('/api/tax/personal/2026/return');
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.cached, false);
  assert.ok(first.body.completeness, 'missing on the cache-miss path');

  const second = await authed.get('/api/tax/personal/2026/return');
  assert.equal(second.body.cached, true, 'expected a cache hit');
  assert.ok(second.body.completeness, 'missing on the cache-hit path — the early return');
  assert.equal(second.body.completeness.status, 'blocked');
});

test('a corp scenario carries no completeness report', async () => {
  // The same hole exists on the T2 side and is deliberately out of scope; the DTO
  // marks the field optional rather than shipping an empty report that reads as clean.
  const models = await import('../models/index.js');
  const corpScenario = await models.Scenario.create({
    entityId: corpId, year: 2026, kind: 'baseline', name: 'Corp Baseline',
    parentId: null, overrides: {}, assumptions: {},
  } as never);
  const res = await authed.get(`/api/tax/scenarios/corp/${corpScenario.id}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.computed.completeness, undefined);
});
