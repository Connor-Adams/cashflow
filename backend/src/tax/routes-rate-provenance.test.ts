/**
 * The scenario return route must refuse to serve a closed year computed from a
 * rate table nobody verified.
 *
 * This is the guard against the failure the whole part fixes: `rates-2026.ts`
 * disclosed in a header comment that it held projected constants an engineer
 * "MUST update once CRA publishes", and the route served it for months. Only a
 * machine-checked field enforced at the request boundary catches that.
 *
 * Enforced at the boundary and NOT inside compute, for a reason this test pins
 * down: `projectPersonalFactsFromPrevYear` resolves a projection by computing its
 * parent, so a refusal inside `computeScenarioReturn` cascades — a 2026 chain
 * rooted at the unverified 2024 table refused to serve 2026. Refusing to SERVE a
 * closed year's return is the defensible claim; refusing every descendant of one
 * is not.
 */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import crypto from 'crypto';

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let entityId: number;

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
    email: `rate-provenance-${Date.now()}@example.com`,
    displayName: 'Rate Provenance Test',
    globalRole: 'user',
    passwordHash: password.hash,
    passwordSalt: password.salt,
    passwordParams: password.params,
  });
  const household = await models.Household.create({ name: 'Provenance HH' });
  await models.HouseholdMember.create({
    householdId: household.id, userId: user.id, role: 'owner',
  });
  const entity = await models.Entity.create({
    householdId: household.id, kind: 'personal', legalName: 'P',
    jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  entityId = entity.id;

  const token = crypto.randomBytes(32).toString('hex');
  await models.Session.create({
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
  });
  authed = request.agent(app);
  authed.jar.setCookie(`cashflow_session=${token}; Path=/`);
});

async function baselineFor(year: number): Promise<number> {
  const models = await import('../models/index.js');
  const s = await models.Scenario.create({
    entityId, year, kind: 'baseline', name: `Baseline ${year}`,
    parentId: null, overrides: {}, assumptions: {},
  } as never);
  return s.id;
}

test('a closed year on a projected table is refused with 409, naming the file', async () => {
  // rates-2024.ts: "ENCODED … from plan recall. NOT cross-checked against CRA".
  // 2024 is filed. Serving it as authoritative is the failure being fixed.
  const id = await baselineFor(2024);
  const res = await authed.get(`/api/tax/scenarios/personal/${id}`);
  assert.equal(res.status, 409, `expected 409, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.match(res.body.error, /rates-2024\.ts/);
});

test('an open year on a published table is served', async () => {
  // 2026 does not close until 2026-12-31, and its table is published — so the
  // guard is dormant for the window Connor actually works in. Stated, not hidden.
  const id = await baselineFor(2026);
  const res = await authed.get(`/api/tax/scenarios/personal/${id}`);
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.ok(res.body.computed, 'expected a computed return');
});

test('a closed year on a published table is served', async () => {
  // 2025 is closed and published: closedness alone must not refuse anything.
  const id = await baselineFor(2025);
  const res = await authed.get(`/api/tax/scenarios/personal/${id}`);
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
});
